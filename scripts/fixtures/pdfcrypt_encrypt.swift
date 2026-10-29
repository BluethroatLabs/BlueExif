// Independent PDF encryptor for the pdfcrypt fixtures. It writes small PDFs
// from scratch and encrypts them with the Standard Security Handler (ISO
// 32000-2 §7.6) using only Apple's crypto (CommonCrypto + CryptoKit). It
// shares no code with BlueExif's TypeScript decryptor, which it is meant to
// test. Covers what no installed tool writes: AES-256 (R5/R6), crypt filters
// (/V2, /Identity), /EncryptMetadata false, object streams + xref streams with
// AES, incremental updates of encrypted files and non-ASCII RC4 passwords in
// PDFDocEncoding (Ghostscript hashes UTF-8, Quartz and PDFKit take ASCII only).
//
// Usage: pdfcrypt_encrypt <specs.json>   (array of Spec, see below)

import CommonCrypto
import CryptoKit
import Foundation

typealias Bytes = [UInt8]

func bytes(_ s: String) -> Bytes { Array(s.utf8) }

// MARK: - crypto

func md5(_ d: Bytes) -> Bytes { Array(Insecure.MD5.hash(data: d)) }

func sha2(_ d: Bytes, _ bits: Int) -> Bytes {
  switch bits {
  case 256: return Array(SHA256.hash(data: d))
  case 384: return Array(SHA384.hash(data: d))
  default: return Array(SHA512.hash(data: d))
  }
}

func ccCrypt(_ alg: Int, _ options: Int, _ key: Bytes, _ iv: Bytes, _ data: Bytes) -> Bytes {
  var out = Bytes(repeating: 0, count: data.count + 32)
  var moved = 0
  let status = CCCrypt(
    CCOperation(kCCEncrypt), CCAlgorithm(alg), CCOptions(options), key, key.count, iv, data, data.count, &out, out.count,
    &moved)
  precondition(status == kCCSuccess, "CCCrypt failed: \(status)")
  return Array(out[0..<moved])
}

let zeroIV = Bytes(repeating: 0, count: 16)

func rc4(_ key: Bytes, _ d: Bytes) -> Bytes { d.isEmpty ? [] : ccCrypt(kCCAlgorithmRC4, 0, key, zeroIV, d) }

func aesCBC(_ key: Bytes, _ iv: Bytes, _ d: Bytes, pad: Bool) -> Bytes {
  ccCrypt(kCCAlgorithmAES, pad ? kCCOptionPKCS7Padding : 0, key, iv, d)
}

func aesECB(_ key: Bytes, _ d: Bytes) -> Bytes { ccCrypt(kCCAlgorithmAES, kCCOptionECBMode, key, zeroIV, d) }

/// Deterministic "random" bytes so regenerated fixtures are identical.
struct Rng {
  var state: Bytes
  init(_ seed: String) { state = sha2(bytes(seed), 256) }
  mutating func next(_ n: Int) -> Bytes {
    var out = Bytes()
    while out.count < n {
      state = sha2(state, 256)
      out += state
    }
    return Array(out.prefix(n))
  }
}

/// zlib stream (RFC 1950) around Foundation's raw DEFLATE.
func zlib(_ d: Bytes) -> Bytes {
  let raw = try! (Data(d) as NSData).compressed(using: .zlib) as Data
  var a: UInt32 = 1
  var b: UInt32 = 0
  for x in d {
    a = (a + UInt32(x)) % 65521
    b = (b + a) % 65521
  }
  let adler = (b << 16) | a
  return [0x78, 0x9c] + Array(raw) + [UInt8(adler >> 24), UInt8((adler >> 16) & 0xff), UInt8((adler >> 8) & 0xff), UInt8(adler & 0xff)]
}

func le32(_ v: Int32) -> Bytes {
  let u = UInt32(bitPattern: v)
  return [UInt8(u & 0xff), UInt8((u >> 8) & 0xff), UInt8((u >> 16) & 0xff), UInt8(u >> 24)]
}

// MARK: - security handler

let PAD: Bytes = [
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]

func padPassword(_ p: Bytes) -> Bytes { Array((p + PAD).prefix(32)) }

enum Method { case none, rc4, aes128, aes256 }

struct Security {
  let r: Int
  let keyLength: Int
  let stm: Method
  let str: Method
  let eff: Method
  let encryptMetadata: Bool
  let key: Bytes
  let dict: V

  func objectKey(_ num: Int, _ gen: Int, _ m: Method) -> Bytes {
    if m == .aes256 { return key }
    var d = key + [UInt8(num & 0xff), UInt8((num >> 8) & 0xff), UInt8((num >> 16) & 0xff), UInt8(gen & 0xff), UInt8((gen >> 8) & 0xff)]
    if m == .aes128 { d += bytes("sAlT") }
    return Array(md5(d).prefix(min(keyLength + 5, 16)))
  }

  func encrypt(_ d: Bytes, _ num: Int, _ gen: Int, _ m: Method, _ rng: inout Rng) -> Bytes {
    switch m {
    case .none: return d
    case .rc4: return rc4(objectKey(num, gen, m), d)
    case .aes128, .aes256:
      let iv = rng.next(16)
      return iv + aesCBC(objectKey(num, gen, m), iv, d, pad: true)
    }
  }
}

/// Algorithm 2.B (R6) or SHA-256 (R5).
func hashR6(_ r: Int, _ pw: Bytes, _ salt: Bytes, _ udata: Bytes) -> Bytes {
  var k = sha2(pw + salt + udata, 256)
  if r == 5 { return k }
  var i = 0
  var e = Bytes()
  while i < 64 || Int(e.last!) > i - 32 {
    let k1 = Array([Bytes](repeating: pw + k + udata, count: 64).joined())
    e = aesCBC(Array(k[0..<16]), Array(k[16..<32]), k1, pad: false)
    let m = e.prefix(16).reduce(0) { $0 + Int($1) } % 3
    k = sha2(e, [256, 384, 512][m])
    i += 1
  }
  return Array(k.prefix(32))
}

func saslPassword(_ s: String) -> Bytes { Array(bytes(s.precomposedStringWithCompatibilityMapping).prefix(127)) }

/// R2–R4 passwords are PDFDocEncoding: Latin-1 plus a few characters of its 0x80–0xA0 range.
func pdfDocPassword(_ s: String) -> Bytes {
  let high: [Character: UInt8] = ["•": 0x80, "—": 0x84, "–": 0x85, "™": 0x92, "€": 0xA0]
  return s.map { c in
    if let b = high[c] { return b }
    guard let v = c.unicodeScalars.first?.value, c.unicodeScalars.count == 1, v >= 0x20, v <= 0xff, !(0x7f...0xa0).contains(v) else {
      fatalError("password character \(c) is not in this encoder's PDFDocEncoding subset")
    }
    return UInt8(v)
  }
}

func makeSecurity(_ s: Spec, id0: Bytes, rng: inout Rng) -> Security {
  let P: Int32 = s.owner.isEmpty || s.user.isEmpty ? -3904 : -4
  if s.r >= 5 {
    let key = rng.next(32)
    let upw = saslPassword(s.user)
    let opw = saslPassword(s.owner)
    let uvs = rng.next(8), uks = rng.next(8), ovs = rng.next(8), oks = rng.next(8)
    let U = hashR6(s.r, upw, uvs, []) + uvs + uks
    let UE = aesCBC(hashR6(s.r, upw, uks, []), zeroIV, key, pad: false)
    let O = hashR6(s.r, opw, ovs, U) + ovs + oks
    let OE = aesCBC(hashR6(s.r, opw, oks, U), zeroIV, key, pad: false)
    let perms = aesECB(key, le32(P) + [0xff, 0xff, 0xff, 0xff] + bytes(s.encryptMetadata ? "T" : "F") + bytes("adb") + rng.next(4))
    var d: [(String, V)] = [
      ("Filter", .name("Standard")), ("V", .int(5)), ("R", .int(s.r)), ("Length", .int(256)),
      ("CF", .dict([("StdCF", .dict([("AuthEvent", .name("DocOpen")), ("CFM", .name("AESV3")), ("Length", .int(32))]))])),
      ("StmF", .name("StdCF")), ("StrF", .name("StdCF")),
      ("O", .hex(O)), ("U", .hex(U)), ("OE", .hex(OE)), ("UE", .hex(UE)), ("Perms", .hex(perms)), ("P", .int(Int(P))),
    ]
    if !s.encryptMetadata { d.append(("EncryptMetadata", .bool(false))) }
    return Security(r: s.r, keyLength: 32, stm: .aes256, str: .aes256, eff: .aes256, encryptMetadata: s.encryptMetadata, key: key, dict: .dict(d))
  }
  // R2–R4: Algorithms 3 (O), 2 (file key), 4/5 (U).
  let n = s.r == 2 ? 5 : s.bits / 8
  let user = pdfDocPassword(s.user)
  var h = md5(padPassword(pdfDocPassword(s.owner.isEmpty ? s.user : s.owner)))
  if s.r >= 3 { for _ in 0..<50 { h = md5(Array(h.prefix(n))) } }
  let ownerKey = Array(h.prefix(n))
  var O = rc4(ownerKey, padPassword(user))
  if s.r >= 3 { for i in 1...19 { O = rc4(ownerKey.map { $0 ^ UInt8(i) }, O) } }
  var d = padPassword(user) + O + le32(P) + id0
  if s.r >= 4 && !s.encryptMetadata { d += [0xff, 0xff, 0xff, 0xff] }
  var k = md5(d)
  if s.r >= 3 { for _ in 0..<50 { k = md5(Array(k.prefix(n))) } }
  let key = Array(k.prefix(n))
  var U: Bytes
  if s.r == 2 {
    U = rc4(key, PAD)
  } else {
    U = rc4(key, md5(PAD + id0))
    for i in 1...19 { U = rc4(key.map { $0 ^ UInt8(i) }, U) }
    U += rng.next(16)
  }
  var dict: [(String, V)] = [("Filter", .name("Standard")), ("V", .int(s.v)), ("R", .int(s.r)), ("Length", .int(s.bits))]
  var method: Method = .rc4
  if s.v == 4 {
    method = s.cfm == "AESV2" ? .aes128 : .rc4
    dict += [
      ("CF", .dict([("StdCF", .dict([("AuthEvent", .name("DocOpen")), ("CFM", .name(s.cfm ?? "V2")), ("Length", .int(16))]))])),
      ("StmF", .name("StdCF")), ("StrF", .name("StdCF")), ("EFF", .name(s.eff ?? "StdCF")),
    ]
    if !s.encryptMetadata { dict.append(("EncryptMetadata", .bool(false))) }
  }
  dict += [("O", .hex(O)), ("U", .hex(U)), ("P", .int(Int(P)))]
  let eff: Method = s.eff == "Identity" ? .none : method
  return Security(r: s.r, keyLength: n, stm: method, str: method, eff: eff, encryptMetadata: s.encryptMetadata || s.v < 4, key: key, dict: .dict(dict))
}

// MARK: - PDF objects

indirect enum V {
  case int(Int), real(Double), name(String), bool(Bool), ref(Int), null
  /// text string (encrypted; written as a literal string)
  case text(String)
  /// byte string (encrypted; written as a hex string)
  case data(Bytes)
  /// never encrypted (encryption dictionary, trailer ID)
  case hex(Bytes)
  case arr([V]), dict([(String, V)])
}

func textBytes(_ s: String) -> Bytes {
  if s.unicodeScalars.allSatisfy({ $0.value < 0x80 }) { return bytes(s) }
  var out: Bytes = [0xfe, 0xff]
  for u in s.utf16 { out += [UInt8(u >> 8), UInt8(u & 0xff)] }
  return out
}

func hexString(_ b: Bytes) -> String { "<" + b.map { String(format: "%02X", $0) }.joined() + ">" }

/// Literal string with only the mandatory escapes; other bytes are written raw.
func literal(_ b: Bytes) -> Bytes {
  var out: Bytes = [0x28]
  for c in b {
    switch c {
    case 0x28, 0x29, 0x5c: out += [0x5c, c]
    case 0x0d: out += bytes("\\r")
    default: out.append(c)
    }
  }
  return out + [0x29]
}

/// Serialize `v`; `enc` encrypts string bytes (identity outside encrypted objects).
func ser(_ v: V, _ enc: (Bytes) -> Bytes) -> Bytes {
  switch v {
  case .int(let i): return bytes(String(i))
  case .real(let d): return bytes(String(format: "%.2f", d))
  case .name(let n): return bytes("/" + n.replacingOccurrences(of: "/", with: "#2F"))
  case .bool(let b): return bytes(b ? "true" : "false")
  case .ref(let n): return bytes("\(n) 0 R")
  case .null: return bytes("null")
  case .text(let s): return literal(enc(textBytes(s)))
  case .data(let b): return bytes(hexString(enc(b)))
  case .hex(let b): return bytes(hexString(b))
  case .arr(let a): return bytes("[") + Array(a.map { ser($0, enc) }.joined(separator: bytes(" "))) + bytes("]")
  case .dict(let d):
    var out = bytes("<<")
    for (k, x) in d { out += bytes("/\(k) ") + ser(x, enc) + bytes("\n") }
    return out + bytes(">>")
  }
}

struct Obj {
  let num: Int
  var value: V
  /// stream data as stored (already filtered)
  var stream: Bytes? = nil
  /// crypt method override for this stream (e.g. an /Identity crypt filter)
  var method: Method? = nil
  /// prefix the (unfiltered) data with spaces until its ciphertext ends in CR
  var tuneTail = false
}

func streamObj(_ num: Int, _ dict: [(String, V)], _ data: Bytes, flate: Bool = true, method: Method? = nil) -> Obj {
  let stored = flate ? zlib(data) : data
  var d = dict
  if flate {
    if let i = d.firstIndex(where: { $0.0 == "Filter" }) {
      if case .arr(let a) = d[i].1 { d[i].1 = .arr(a + [.name("FlateDecode")]) }
    } else {
      d.append(("Filter", .name("FlateDecode")))
    }
  }
  return Obj(num: num, value: .dict(d), stream: stored, method: method)
}

// MARK: - document

struct Spec: Decodable {
  let out: String
  let v: Int
  let r: Int
  let bits: Int
  let cfm: String?
  let user: String
  let owner: String
  let title: String
  let author: String
  /// title of an appended incremental update (the base revision keeps `title`)
  let updateTitle: String?
  let pages: Int
  let xrefStream: Bool
  let encryptMetadata: Bool
  let identityStream: Bool
  /// pack the catalog into the object stream too (CoreGraphics cannot open such files before unlocking)
  let catalogInObjStm: Bool?
  /// stream lengths as indirect objects (packed into the object stream with `xrefStream`,
  /// as Ghostscript does), and page 1's ciphertext ends in CR
  let indirectLengths: Bool?
  let marker: String
  /// V4 only: crypt filter for embedded files (default StdCF; "Identity" leaves them in the clear)
  let eff: String?
  /// with `xrefStream` and `updateTitle`: the revision ("base" or "update") whose Info is a
  /// top-level object, while the other one packs it into an object stream
  let infoTopLevel: String?
  /// a signature field whose /Contents is (per ISO 32000-2) never encrypted
  let signature: Bool?
}

/// Signature value bytes, stored unencrypted.
let sigContents = bytes("SIGNATURE-BYTES-NOT-ENCRYPTED") + Bytes(repeating: 0, count: 35)

let xmpTemplate = """
  <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
  <x:xmpmeta xmlns:x="adobe:ns:meta/">
   <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
     <dc:title><rdf:Alt><rdf:li xml:lang="x-default">TITLE</rdf:li></rdf:Alt></dc:title>
     <dc:creator><rdf:Seq><rdf:li>AUTHOR</rdf:li></rdf:Seq></dc:creator>
     <xmp:CreatorTool>BlueExif independent encryptor</xmp:CreatorTool>
     <xmp:CreateDate>2024-05-01T10:30:00+02:00</xmp:CreateDate>
     <pdf:Producer>Swift CommonCrypto</pdf:Producer>
    </rdf:Description>
   </rdf:RDF>
  </x:xmpmeta>
  <?xpacket end="w"?>
  """

func info(_ s: Spec, _ title: String) -> V {
  .dict([
    ("Title", .text(title)), ("Author", .text(s.author)), ("Subject", .text("Encrypted fixture")),
    ("Keywords", .text("alpha, beta")), ("Creator", .text("BlueExif independent encryptor")),
    ("Producer", .text("Swift CommonCrypto")), ("CreationDate", .text("D:20240501103000+02'00'")),
    ("ModDate", .text("D:20240502110000Z")), ("Company", .text("Acme \(s.marker) Inc")),
  ])
}

/// Objects of the first revision. Numbers: 1 catalog, 2 pages, 3 XMP, 4 font,
/// 5 Info, 6 attachment spec, 7 attachment data, then per page: page, content
/// (+ annotation on page 1, + identity-filtered stream).
func documentObjects(_ s: Spec) -> [Obj] {
  // The XMP matches the latest revision, so `title` survives only in the superseded Info.
  let xmp = xmpTemplate.replacingOccurrences(of: "TITLE", with: s.updateTitle ?? s.title).replacingOccurrences(of: "AUTHOR", with: s.author)
  var objs: [Obj] = [
    Obj(num: 4, value: .dict([("Type", .name("Font")), ("Subtype", .name("Type1")), ("BaseFont", .name("Helvetica"))])),
    Obj(num: 5, value: info(s, s.title)),
    Obj(num: 6, value: .dict([
      ("Type", .name("Filespec")), ("F", .text("notes.txt")), ("UF", .text("notes.txt")), ("Desc", .text("Meeting notes")),
      ("EF", .dict([("F", .ref(7))])),
    ])),
    streamObj(7, [
      ("Type", .name("EmbeddedFile")), ("Subtype", .name("text/plain")),
      ("Params", .dict([("Size", .int(33)), ("CreationDate", .text("D:20240501080000Z")), ("ModDate", .text("D:20240502080000Z"))])),
    ], bytes("Meeting notes: totals look fine.\n")),
    // Compressed when left unencrypted, so only /EncryptMetadata (not its plain-text look) says so.
    streamObj(3, [("Type", .name("Metadata")), ("Subtype", .name("XML"))], bytes(xmp), flate: !s.encryptMetadata),
  ]
  var kids: [V] = []
  var next = 8
  var catalog: [(String, V)] = []
  for p in 1...s.pages {
    let page = next, content = next + 1
    next += 2
    var pd: [(String, V)] = [
      ("Type", .name("Page")), ("Parent", .ref(2)), ("MediaBox", .arr([.int(0), .int(0), .int(300), .int(200)])),
      ("Resources", .dict([("Font", .dict([("F1", .ref(4))]))])),
    ]
    let text = "0.8 0.2 0.2 rg \(20 * p) 40 120 60 re f\nBT /F1 20 Tf 20 150 Td (Encrypted page \(p) of \(s.pages)) Tj ET\n"
    var c = streamObj(content, [], bytes(text), flate: !(s.indirectLengths ?? false))
    c.tuneTail = p == 1 && (s.indirectLengths ?? false)
    objs.append(c)
    var contents: [V] = [.ref(content)]
    if p == 1 {
      let annot = next
      next += 1
      objs.append(Obj(num: annot, value: .dict([
        ("Type", .name("Annot")), ("Subtype", .name("Text")), ("Rect", .arr([.int(250), .int(150), .int(270), .int(170)])),
        ("Contents", .text("Please check the totals")), ("T", .text("Reviewer \(s.marker)")), ("M", .text("D:20240503090000Z")),
      ])))
      var annots: [V] = [.ref(annot)]
      if s.signature ?? false {
        let field = next, sig = next + 1
        next += 2
        objs.append(Obj(num: sig, value: .dict([
          ("Type", .name("Sig")), ("Filter", .name("Adobe.PPKLite")), ("SubFilter", .name("adbe.pkcs7.detached")),
          ("ByteRange", .arr([.int(0), .int(0), .int(0), .int(0)])), ("Contents", .hex(sigContents)),
          ("Name", .text("Jane Signer")), ("M", .text("D:20240504120000Z")),
        ])))
        objs.append(Obj(num: field, value: .dict([
          ("Type", .name("Annot")), ("Subtype", .name("Widget")), ("FT", .name("Sig")), ("T", .text("Signature1")),
          ("V", .ref(sig)), ("F", .int(132)), ("Rect", .arr([.int(0), .int(0), .int(0), .int(0)])), ("P", .ref(page)),
        ])))
        annots.append(.ref(field))
        catalog.append(("AcroForm", .dict([("Fields", .arr([.ref(field)])), ("SigFlags", .int(3))])))
      }
      pd.append(("Annots", .arr(annots)))
      if s.identityStream {
        let plain = next
        next += 1
        // [/Crypt /FlateDecode] with the /Identity crypt filter: stored unencrypted.
        let parms: V = .arr([.dict([("Type", .name("CryptFilterDecodeParms")), ("Name", .name("Identity"))]), .null])
        let o = streamObj(
          plain, [("Filter", .arr([.name("Crypt")])), ("DecodeParms", parms)], bytes("0 0 1 rg 200 20 60 30 re f\n"), method: Method.none)
        objs.append(o)
        contents.append(.ref(plain))
      }
    }
    pd.append(("Contents", contents.count == 1 ? contents[0] : .arr(contents)))
    objs.append(Obj(num: page, value: .dict(pd)))
    kids.append(.ref(page))
  }
  objs.append(Obj(num: 2, value: .dict([("Type", .name("Pages")), ("Kids", .arr(kids)), ("Count", .int(s.pages))])))
  objs.append(Obj(num: 1, value: .dict([
    ("Type", .name("Catalog")), ("Pages", .ref(2)), ("Metadata", .ref(3)),
    ("Names", .dict([("EmbeddedFiles", .dict([("Names", .arr([.text("notes.txt"), .ref(6)]))]))])),
  ] + catalog)))
  return objs.sorted { $0.num < $1.num }
}

// MARK: - writer

struct XrefEntry {
  let num: Int
  let type: Int  // 1 = offset, 2 = in object stream
  let a: Int  // offset or object stream number
  let b: Int  // generation or index
}

final class PdfWriter {
  var out = Bytes()
  var rng: Rng
  let sec: Security
  let encNum: Int
  let id0: Bytes
  /// next free object number
  var nextNum: Int
  /// write stream /Length as an indirect object
  var indirectLengths = false
  /// with `indirectLengths`: collect the /Length objects for the next object stream instead of writing them
  var packLengths = false
  var pendingLengths: [Obj] = []

  init(_ sec: Security, encNum: Int, id0: Bytes, rng: Rng) {
    self.sec = sec
    self.encNum = encNum
    self.id0 = id0
    self.rng = rng
    nextNum = encNum + 1
  }

  func write(_ s: String) { out += bytes(s) }

  func streamMethod(_ o: Obj) -> Method {
    if let m = o.method { return m }
    if case .dict(let d) = o.value, let t = d.first(where: { $0.0 == "Type" })?.1, case .name(let n) = t {
      if n == "Metadata" && !sec.encryptMetadata { return .none }
      if n == "EmbeddedFile" { return sec.eff }
    }
    return sec.stm
  }

  /// Write an indirect object, encrypting its strings and stream unless it is the Encrypt dictionary.
  func writeObject(_ o: Obj, encrypt: Bool = true) -> [XrefEntry] {
    let offset = out.count
    var rng = self.rng
    let strMethod = encrypt ? sec.str : .none
    let enc: (Bytes) -> Bytes = { [sec] b in sec.encrypt(b, o.num, 0, strMethod, &rng) }
    write("\(o.num) 0 obj\n")
    var lengthObj: (Int, Int)? = nil
    if var data = o.stream {
      var stored = encrypt ? sec.encrypt(data, o.num, 0, streamMethod(o), &rng) : data
      // Ciphertext ending in CR before "\nendstream" trips readers that search for "endstream";
      // with AES the final block must also carry content (not just padding) for the loss to show.
      let aes = streamMethod(o) == .aes128 || streamMethod(o) == .aes256
      while o.tuneTail && (stored.last != 0x0d || (aes && data.count % 16 < 12)) {
        data = bytes(" ") + data
        stored = sec.encrypt(data, o.num, 0, streamMethod(o), &rng)
      }
      guard case .dict(let d) = o.value else { fatalError("stream without dict") }
      var length: V = .int(stored.count)
      if indirectLengths && encrypt {
        lengthObj = (nextNum, stored.count)
        length = .ref(nextNum)
        nextNum += 1
      }
      out += ser(.dict(d + [("Length", length)]), enc)
      out += bytes("\nstream\r\n") + stored + bytes("\nendstream")
    } else {
      out += ser(o.value, enc)
    }
    write("\nendobj\n")
    self.rng = rng
    var entries = [XrefEntry(num: o.num, type: 1, a: offset, b: 0)]
    if let (num, len) = lengthObj {
      if packLengths {
        pendingLengths.append(Obj(num: num, value: .int(len)))
      } else {
        entries.append(XrefEntry(num: num, type: 1, a: out.count, b: 0))
        write("\(num) 0 obj\n\(len)\nendobj\n")
      }
    }
    return entries
  }

  /// Write one revision: its objects, then a classic xref table or an xref stream (with an object stream).
  func revision(_ objs: [Obj], xrefStream: Bool, catalogInObjStm: Bool, topLevel: Set<Int> = [], prev: Int?) -> Int {
    var entries: [XrefEntry] = []
    if xrefStream {
      let packable = { (o: Obj) in o.stream == nil && (catalogInObjStm || o.num != 1) && !topLevel.contains(o.num) }
      packLengths = indirectLengths
      for o in objs where !packable(o) { entries += writeObject(o) }
      let packed = objs.filter(packable) + pendingLengths
      pendingLengths = []
      packLengths = false
      if !packed.isEmpty {
        let stmNum = nextNum
        nextNum += 1
        var header = ""
        var body = Bytes()
        for (i, o) in packed.enumerated() {
          header += "\(o.num) \(body.count) "
          body += ser(o.value, { $0 }) + bytes("\n")  // members of object streams are not encrypted
          entries.append(XrefEntry(num: o.num, type: 2, a: stmNum, b: i))
        }
        let head = bytes(header + "\n")
        let stm = streamObj(stmNum, [("Type", .name("ObjStm")), ("N", .int(packed.count)), ("First", .int(head.count))], head + body)
        // An object stream's own /Length must not live in an object stream: keep it direct.
        let indirect = indirectLengths
        indirectLengths = false
        entries += writeObject(stm)
        indirectLengths = indirect
      }
    } else {
      for o in objs { entries += writeObject(o) }
    }
    if prev == nil { entries += writeObject(Obj(num: encNum, value: sec.dict), encrypt: false) }
    entries.sort { $0.num < $1.num }

    let trailer: [(String, V)] = [
      ("Root", .ref(1)), ("Info", .ref(5)), ("Encrypt", .ref(encNum)), ("ID", .arr([.hex(id0), .hex(id0)])),
    ] + (prev.map { [("Prev", V.int($0))] } ?? [])
    // Contiguous runs of object numbers (plus object 0 in the first revision).
    var runs: [[XrefEntry]] = []
    for e in entries {
      if let last = runs.last?.last, last.num + 1 == e.num { runs[runs.count - 1].append(e) } else { runs.append([e]) }
    }
    if xrefStream {
      let xrefNum = nextNum
      nextNum += 1
      let offset = out.count
      var rows = Bytes()
      var index: [V] = []
      let all = (prev == nil ? [XrefEntry(num: 0, type: 0, a: 0, b: 65535)] : []) + entries + [XrefEntry(num: xrefNum, type: 1, a: offset, b: 0)]
      var xr: [[XrefEntry]] = []
      for e in all {
        if let last = xr.last?.last, last.num + 1 == e.num { xr[xr.count - 1].append(e) } else { xr.append([e]) }
      }
      for run in xr {
        index += [.int(run[0].num), .int(run.count)]
        for e in run {
          let a = UInt32(e.a), g = UInt16(e.b)
          rows += [UInt8(e.type), UInt8(a >> 24), UInt8((a >> 16) & 0xff), UInt8((a >> 8) & 0xff), UInt8(a & 0xff), UInt8(g >> 8), UInt8(g & 0xff)]
        }
      }
      let dict: [(String, V)] = [("Type", .name("XRef")), ("Size", .int(nextNum)), ("W", .arr([.int(1), .int(4), .int(2)])), ("Index", .arr(index))] + trailer
      _ = writeObject(streamObj(xrefNum, dict, rows), encrypt: false)
      write("startxref\n\(offset)\n%%EOF\n")
      return offset
    }
    let offset = out.count
    write("xref\n")
    if prev == nil { runs.insert([XrefEntry(num: 0, type: 0, a: 0, b: 65535)], at: 0) }
    var merged: [[XrefEntry]] = []
    for run in runs {
      if let last = merged.last?.last, last.num + 1 == run[0].num { merged[merged.count - 1] += run } else { merged.append(run) }
    }
    for run in merged {
      write("\(run[0].num) \(run.count)\n")
      for e in run { write(e.type == 0 ? "0000000000 65535 f\r\n" : String(format: "%010d %05d n\r\n", e.a, e.b)) }
    }
    write("trailer\n")
    out += ser(.dict([("Size", .int(nextNum))] + trailer), { $0 })
    write("\nstartxref\n\(offset)\n%%EOF\n")
    return offset
  }
}

func build(_ s: Spec) -> Bytes {
  var rng = Rng(URL(fileURLWithPath: s.out).lastPathComponent)  // seeded by name: regenerated files are identical
  let id0 = rng.next(16)
  let sec = makeSecurity(s, id0: id0, rng: &rng)
  let objs = documentObjects(s)
  let maxNum = objs.map(\.num).max()!
  let encNum = maxNum + 1
  let w = PdfWriter(sec, encNum: encNum, id0: id0, rng: rng)
  w.write("%PDF-1.7\n%\u{E2}\u{E3}\u{CF}\u{D3}\n")
  let inStm = s.catalogInObjStm ?? false
  w.indirectLengths = s.indirectLengths ?? false
  let base = w.revision(objs, xrefStream: s.xrefStream, catalogInObjStm: inStm, topLevel: s.infoTopLevel == "base" ? [5] : [], prev: nil)
  if let t = s.updateTitle {
    // Incremental update: Info is redefined under the same number.
    _ = w.revision(
      [Obj(num: 5, value: info(s, t))], xrefStream: s.xrefStream, catalogInObjStm: inStm, topLevel: s.infoTopLevel == "update" ? [5] : [], prev: base)
  }
  return w.out
}

let specs = try! JSONDecoder().decode([Spec].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
for s in specs {
  try! Data(build(s)).write(to: URL(fileURLWithPath: s.out))
}
