// Real-tool side of the pdfcrypt fixtures (macOS CoreGraphics + PDFKit).
//
//   pdfcrypt_tools make <dir> <marker>
//     Quartz (CGPDFContext) writes source.pdf (plain) and encrypted variants;
//     PDFKit re-saves source.pdf with passwords (PDFDocument.write options).
//   pdfcrypt_tools check <file> [password]
//     Prints JSON from PDFKit: encryption/lock state, whether the password
//     unlocks it, page count, Title/Author and a small grayscale rendering of
//     every page (base64) — an independent reader for fixtures and tests.
//     A password "hex:<bytes>" is passed to CoreGraphics as those raw bytes
//     (PDFKit only takes ASCII passwords); that check has no renderings.

import AppKit
import CoreGraphics
import CoreText
import Foundation
import PDFKit

func makeQuartz(_ path: String, marker: String, _ extra: [CFString: Any]) {
  var box = CGRect(x: 0, y: 0, width: 300, height: 200)
  var info: [CFString: Any] = [
    kCGPDFContextTitle: "Quartz encrypted",
    kCGPDFContextAuthor: "Quartz Author \(marker)",
    kCGPDFContextCreator: "BlueExif fixture generator",
    kCGPDFContextSubject: "Encryption fixture",
    kCGPDFContextKeywords: "alpha, beta",
  ]
  for (k, v) in extra { info[k] = v }
  guard let c = CGContext(URL(fileURLWithPath: path) as CFURL, mediaBox: &box, info as CFDictionary) else {
    fatalError("cannot create \(path)")
  }
  let xmp = """
    <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>XMP Author \(marker)</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>
    """
  c.addDocumentMetadata(xmp.data(using: .utf8)! as CFData)
  // A small RGB image so an image XObject is encrypted too.
  let px = 8
  var pixels = [UInt8](repeating: 0, count: px * px * 4)
  for i in 0..<(px * px) { pixels[i * 4] = UInt8(i * 4); pixels[i * 4 + 1] = 120; pixels[i * 4 + 2] = UInt8(255 - i * 4); pixels[i * 4 + 3] = 255 }
  let img = CGContext(
    data: &pixels, width: px, height: px, bitsPerComponent: 8, bytesPerRow: px * 4, space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!.makeImage()!
  for p in 1...2 {
    c.beginPDFPage(nil)
    c.setFillColor(red: 0.8, green: 0.2, blue: 0.2, alpha: 1)
    c.fill(CGRect(x: 20 * p, y: 30, width: 120, height: 50))
    c.draw(img, in: CGRect(x: 200, y: 100, width: 64, height: 64))
    let font = CTFontCreateWithName("Helvetica" as CFString, 18, nil)
    let text = NSAttributedString(string: "Encrypted page \(p)", attributes: [.font: font])
    c.textPosition = CGPoint(x: 20, y: 150)
    CTLineDraw(CTLineCreateWithAttributedString(text), c)
    c.endPDFPage()
  }
  c.closePDF()
}

func make(_ dir: String, _ marker: String) {
  let p = { (name: String) in dir + "/" + name }
  makeQuartz(p("source.pdf"), marker: marker, [:])
  makeQuartz(p("quartz-rc4-40.pdf"), marker: marker, [kCGPDFContextUserPassword: "user", kCGPDFContextOwnerPassword: "owner", kCGPDFContextEncryptionKeyLength: 40])
  makeQuartz(p("quartz-aes-128.pdf"), marker: marker, [kCGPDFContextUserPassword: "user", kCGPDFContextOwnerPassword: "owner"])
  makeQuartz(p("quartz-owner-only.pdf"), marker: marker, [kCGPDFContextOwnerPassword: "owner", kCGPDFContextAllowsCopying: false])
  // PDFKit: re-save with passwords; add a comment whose author must be stripped.
  guard let doc = PDFDocument(url: URL(fileURLWithPath: p("source.pdf"))), let page = doc.page(at: 0) else { fatalError("source") }
  let note = PDFAnnotation(bounds: CGRect(x: 250, y: 150, width: 20, height: 20), forType: .text, withProperties: nil)
  note.contents = "Please check the totals"
  note.userName = "Reviewer \(marker)"
  page.addAnnotation(note)
  var attrs = doc.documentAttributes ?? [:]
  attrs[PDFDocumentAttribute.titleAttribute] = "PDFKit encrypted"
  doc.documentAttributes = attrs
  let ok = doc.write(to: URL(fileURLWithPath: p("pdfkit-rc4-128.pdf")), withOptions: [.userPasswordOption: "user", .ownerPasswordOption: "owner"])
  precondition(ok, "PDFKit write failed")
}

/// Grayscale rendering of a page, `w` pixels wide.
func render(_ page: PDFPage, width w: Int) -> String {
  let box = page.bounds(for: .mediaBox)
  let h = max(1, Int(Double(w) * box.height / box.width))
  var px = [UInt8](repeating: 255, count: w * h)
  let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0)!
  ctx.setFillColor(gray: 1, alpha: 1)
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.scaleBy(x: CGFloat(w) / box.width, y: CGFloat(h) / box.height)
  page.draw(with: .mediaBox, to: ctx)
  return Data(px).base64EncodedString()
}

/// CoreGraphics' view of a file unlocked with raw password bytes.
func checkRaw(_ path: String, _ hex: String) {
  var out: [String: Any] = [:]
  guard let doc = CGPDFDocument(URL(fileURLWithPath: path) as CFURL) else {
    print("{\"opened\":false}")
    return
  }
  var pw = [CChar]()
  var i = hex.startIndex
  while i < hex.endIndex {
    let j = hex.index(i, offsetBy: 2)
    pw.append(CChar(bitPattern: UInt8(hex[i..<j], radix: 16)!))
    i = j
  }
  out["opened"] = true
  out["encrypted"] = doc.isEncrypted
  out["locked"] = !doc.isUnlocked
  out["unlocked"] = doc.unlockWithPassword(pw + [0])
  if doc.isUnlocked {
    out["pages"] = doc.numberOfPages
    var title: CGPDFStringRef?
    if let info = doc.info, CGPDFDictionaryGetString(info, "Title", &title), let t = title {
      out["title"] = CGPDFStringCopyTextString(t) as String?
    }
  }
  let json = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
  print(String(data: json, encoding: .utf8)!)
}

func check(_ path: String, _ password: String?) {
  if let pw = password, pw.hasPrefix("hex:") { return checkRaw(path, String(pw.dropFirst(4))) }
  var out: [String: Any] = [:]
  guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
    print("{\"opened\":false}")
    return
  }
  out["opened"] = true
  out["encrypted"] = doc.isEncrypted
  out["locked"] = doc.isLocked
  if let pw = password { out["unlocked"] = doc.unlock(withPassword: pw) }
  if !doc.isLocked {
    out["pages"] = doc.pageCount
    let a = doc.documentAttributes ?? [:]
    out["title"] = a[PDFDocumentAttribute.titleAttribute] as? String ?? NSNull()
    out["author"] = a[PDFDocumentAttribute.authorAttribute] as? String ?? NSNull()
    out["renders"] = (0..<doc.pageCount).map { render(doc.page(at: $0)!, width: 96) }
  }
  let json = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
  print(String(data: json, encoding: .utf8)!)
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "make": make(args[2], args[3])
case "check": check(args[2], args.count > 3 ? args[3] : nil)
default:
  FileHandle.standardError.write("usage: pdfcrypt_tools make <dir> <marker> | check <file> [password]\n".data(using: .utf8)!)
  exit(2)
}
