"""Office / ODF / EPUB fixtures for scripts/fixtures/documents.mjs (stdlib only).

Usage: python3 -I documents_office.py OUTDIR TEXTUTIL_DOCX TEXTUTIL_ODT

Builds documents with rich metadata and "hidden" personal information
(comment / tracked-change authors, template paths, printer names, Apple IDs…).
Every identifying value contains SECRET-MARKER-42.
"""

import base64
import struct
import sys
import zipfile
import zlib

MARK = "SECRET-MARKER-42"
OUT, DOCX, ODT = sys.argv[1], sys.argv[2], sys.argv[3]
STAMP = (2024, 5, 1, 10, 0, 0)


def png(w, h, rgb):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def write_zip(name, entries):
    with zipfile.ZipFile(f"{OUT}/{name}", "w") as z:
        for path, data in entries:
            zi = zipfile.ZipInfo(path, date_time=STAMP)
            zi.compress_type = zipfile.ZIP_STORED if path == "mimetype" else zipfile.ZIP_DEFLATED
            z.writestr(zi, data.encode("utf-8") if isinstance(data, str) else data)


def read_zip(path):
    with zipfile.ZipFile(path) as z:
        return [(i.filename, z.read(i.filename)) for i in z.infolist()]


XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
THUMB = png(16, 12, (40, 90, 200))


def core_xml(app):
    return XML + f"""<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Quarterly {app} report</dc:title><dc:subject>Finance</dc:subject><dc:creator>Jane {MARK} Doe</dc:creator><cp:keywords>finance; q3</cp:keywords><dc:description>Internal draft &amp; notes</dc:description><cp:lastModifiedBy>Bob {MARK}</cp:lastModifiedBy><cp:revision>7</cp:revision><cp:lastPrinted>2024-05-03T07:00:00Z</cp:lastPrinted><dcterms:created xsi:type="dcterms:W3CDTF">2024-05-01T10:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2024-05-02T11:30:00Z</dcterms:modified><cp:category>Reports</cp:category><cp:contentStatus>Draft</cp:contentStatus><dc:language>en-US</dc:language><cp:version>1.2</cp:version><dc:identifier>DOC-{MARK}</dc:identifier></cp:coreProperties>"""


def app_xml(application, extra=""):
    return XML + f"""<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Template>Normal.dotm</Template><TotalTime>42</TotalTime>{extra}<Application>{application}</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><Manager>Mallory {MARK}</Manager><Company>Acme {MARK} Inc</Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinkBase>https://intranet.example/{MARK}/</HyperlinkBase><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>"""


CUSTOM = XML + f"""<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{{D5CDD505-2E9C-101B-9397-08002B2CF9AE}}" pid="2" name="Client"><vt:lpwstr>Client {MARK}</vt:lpwstr></property><property fmtid="{{D5CDD505-2E9C-101B-9397-08002B2CF9AE}}" pid="3" name="Budget"><vt:i4>12000</vt:i4></property><property fmtid="{{D5CDD505-2E9C-101B-9397-08002B2CF9AE}}" pid="4" name="Approved"><vt:bool>true</vt:bool></property><property fmtid="{{D5CDD505-2E9C-101B-9397-08002B2CF9AE}}" pid="5" name="Due"><vt:filetime>2024-06-01T00:00:00Z</vt:filetime></property><property fmtid="{{D5CDD505-2E9C-101B-9397-08002B2CF9AE}}" pid="6" name="Rate"><vt:r8>0.25</vt:r8></property></Properties>"""

ROOT_RELS = XML + f"""<Relationships xmlns="{RELS_NS}"><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="{{main}}"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.png"/></Relationships>"""

PROPS_CT = """<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>"""


def rich_docx():
    parts = dict(read_zip(DOCX))
    parts["[Content_Types].xml"] = XML + f"""<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/people.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml"/>{PROPS_CT}</Types>"""
    parts["_rels/.rels"] = ROOT_RELS.replace("{main}", "word/document.xml")
    parts["word/_rels/document.xml.rels"] = XML + f"""<Relationships xmlns="{RELS_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../docProps/meta.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId5" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/></Relationships>"""
    parts["word/document.xml"] = XML + f"""<w:document xmlns:w="{W}" xmlns:r="{R}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"><w:body><w:p w:rsidR="00A1B2C3" w:rsidRDefault="00A1B2C3" w14:paraId="1A2B3C4D" w14:textId="77777777"><w:r><w:t>Hello world, this is the body text.</w:t></w:r></w:p><w:p w:rsidR="00D4E5F6" w:rsidRDefault="00A1B2C3" w:rsidP="00D4E5F6"><w:commentRangeStart w:id="0"/><w:r w:rsidRPr="00D4E5F6"><w:t xml:space="preserve">Revenue grew </w:t></w:r><w:ins w:id="1" w:author="Editor {MARK}" w:date="2024-05-02T09:00:00Z"><w:r><w:t xml:space="preserve">strongly </w:t></w:r></w:ins><w:del w:id="2" w:author="Editor {MARK}" w:date="2024-05-02T09:05:00Z"><w:r w:rsidDel="00D4E5F6"><w:delText xml:space="preserve">slightly </w:delText></w:r></w:del><w:r><w:t>this quarter.</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p><w:sectPr w:rsidR="00A1B2C3"><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>"""
    parts["word/comments.xml"] = XML + f"""<w:comments xmlns:w="{W}"><w:comment w:id="0" w:author="Reviewer {MARK}" w:date="2024-05-03T08:00:00Z" w:initials="RS"><w:p><w:r><w:t>Source for this figure?</w:t></w:r></w:p></w:comment></w:comments>"""
    parts["word/people.xml"] = XML + f"""<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:person w15:author="Reviewer {MARK}"><w15:presenceInfo w15:providerId="AD" w15:userId="S::reviewer@{MARK}.example::1234"/></w15:person></w15:people>"""
    parts["word/settings.xml"] = XML + f"""<w:settings xmlns:w="{W}" xmlns:r="{R}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14 w15"><w:zoom w:percent="100"/><w:attachedTemplate r:id="rId1"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:rsids><w:rsidRoot w:val="00A1B2C3"/><w:rsid w:val="00A1B2C3"/><w:rsid w:val="00D4E5F6"/></w:rsids><w14:docId w14:val="1A2B3C4D"/><w15:docId w15:val="{{5EC4E7AA-0042-4242-9999-000000000042}}"/></w:settings>"""
    parts["word/_rels/settings.xml.rels"] = XML + f"""<Relationships xmlns="{RELS_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="file:///C:\\Users\\{MARK}\\AppData\\Roaming\\Microsoft\\Templates\\Normal.dotm" TargetMode="External"/></Relationships>"""
    parts["docProps/core.xml"] = core_xml("Word")
    parts["docProps/app.xml"] = app_xml("Microsoft Office Word", "<Pages>1</Pages><Words>12</Words><Characters>70</Characters>")
    parts["docProps/custom.xml"] = CUSTOM
    parts["docProps/thumbnail.png"] = THUMB
    order = ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/_rels/document.xml.rels"]
    names = order + [n for n in parts if n not in order]
    write_zip("rich.docx", [(n, parts[n]) for n in names])


def xlsx():
    S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    TC = "http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"
    theme = dict(read_zip(DOCX))["word/theme/theme1.xml"]
    parts = [
        ("[Content_Types].xml", XML + f"""<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/><Override PartName="/xl/persons/person.xml" ContentType="application/vnd.ms-excel.person+xml"/>{PROPS_CT}</Types>"""),
        ("_rels/.rels", ROOT_RELS.replace("{main}", "xl/workbook.xml").replace('<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.png"/>', "")),
        ("xl/workbook.xml", XML + f"""<workbook xmlns="{S}" xmlns:r="{R}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x15" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"><fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/><fileSharing userName="Owner {MARK}"/><workbookPr defaultThemeVersion="166925"/><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x15"><x15ac:absPath xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac" url="C:\\Users\\{MARK}\\Documents\\"/></mc:Choice></mc:AlternateContent><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="16000" windowHeight="9000"/></bookViews><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"""),
        ("xl/_rels/workbook.xml.rels", XML + f"""<Relationships xmlns="{RELS_NS}"><Relationship Id="rId1" Type="{R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="{R}/theme" Target="theme/theme1.xml"/><Relationship Id="rId3" Type="{R}/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.microsoft.com/office/2017/10/relationships/person" Target="persons/person.xml"/></Relationships>"""),
        ("xl/worksheets/sheet1.xml", XML + f"""<worksheet xmlns="{S}" xmlns:r="{R}"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Revenue</t></is></c><c r="B1"><v>1200</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Costs</t></is></c><c r="B2"><v>800</v></c></row></sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><legacyDrawing r:id="rId2"/></worksheet>"""),
        ("xl/worksheets/_rels/sheet1.xml.rels", XML + f"""<Relationships xmlns="{RELS_NS}"><Relationship Id="rId1" Type="{R}/comments" Target="../comments1.xml"/><Relationship Id="rId2" Type="{R}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/></Relationships>"""),
        ("xl/comments1.xml", XML + f"""<comments xmlns="{S}"><authors><author>Reviewer {MARK}</author></authors><commentList><comment ref="B1" authorId="0"><text><r><t>Check this number</t></r></text></comment></commentList></comments>"""),
        ("xl/drawings/vmlDrawing1.vml", """<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype><v:shape id="_x0000_s1025" type="#_x0000_t202" style="position:absolute;visibility:hidden" fillcolor="#ffffe1"><x:ClientData ObjectType="Note"><x:Row>0</x:Row><x:Column>1</x:Column></x:ClientData></v:shape></xml>"""),
        ("xl/persons/person.xml", XML + f"""<personList xmlns="{TC}" xmlns:x="{S}"><person displayName="Reviewer {MARK}" id="{{5EC4E7AA-1111-2222-3333-444455556666}}" userId="reviewer@{MARK}.example" providerId="AD"/></personList>"""),
        ("xl/styles.xml", XML + f"""<styleSheet xmlns="{S}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"""),
        ("xl/theme/theme1.xml", theme),
        ("docProps/core.xml", core_xml("Excel")),
        ("docProps/app.xml", app_xml("Microsoft Excel", '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Sheet1</vt:lpstr></vt:vector></TitlesOfParts>').replace("<Template>Normal.dotm</Template>", "")),
        ("docProps/custom.xml", CUSTOM),
    ]
    write_zip("book.xlsx", parts)


def pptx():
    P = "http://schemas.openxmlformats.org/presentationml/2006/main"
    A = "http://schemas.openxmlformats.org/drawingml/2006/main"
    theme = dict(read_zip(DOCX))["word/theme/theme1.xml"]
    tree = f'<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>{{shapes}}</p:spTree></p:cSld>'
    title = '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Quarterly results</a:t></a:r></a:p></p:txBody></p:sp>'
    ns = f'xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}"'
    parts = [
        ("[Content_Types].xml", XML + f"""<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/commentAuthors.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml"/><Override PartName="/ppt/comments/comment1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.comments+xml"/>{PROPS_CT}</Types>"""),
        ("_rels/.rels", ROOT_RELS.replace("{main}", "ppt/presentation.xml")),
        ("ppt/presentation.xml", XML + f"""<p:presentation {ns} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>"""),
        ("ppt/_rels/presentation.xml.rels", XML + f"""<Relationships xmlns="{RELS_NS}"><Relationship Id="rId1" Type="{R}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="{R}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="{R}/theme" Target="theme/theme1.xml"/><Relationship Id="rId4" Type="{R}/commentAuthors" Target="commentAuthors.xml"/></Relationships>"""),
        ("ppt/slideMasters/slideMaster1.xml", XML + f"""<p:sldMaster {ns}>{tree.replace("{shapes}", "")}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>"""),
        ("ppt/slideMasters/_rels/slideMaster1.xml.rels", XML + f"""<Relationships xmlns="{RELS_NS}"><Relationship Id="rId1" Type="{R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="{R}/theme" Target="../theme/theme1.xml"/></Relationships>"""),
        ("ppt/slideLayouts/slideLayout1.xml", XML + f"""<p:sldLayout {ns} type="blank">{tree.replace("{shapes}", "")}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"""),
        ("ppt/slideLayouts/_rels/slideLayout1.xml.rels", XML + f"""<Relationships xmlns="{RELS_NS}"><Relationship Id="rId1" Type="{R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>"""),
        ("ppt/slides/slide1.xml", XML + f"""<p:sld {ns}>{tree.replace("{shapes}", title)}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"""),
        ("ppt/slides/_rels/slide1.xml.rels", XML + f"""<Relationships xmlns="{RELS_NS}"><Relationship Id="rId1" Type="{R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="{R}/comments" Target="../comments/comment1.xml"/></Relationships>"""),
        ("ppt/theme/theme1.xml", theme),
        ("ppt/commentAuthors.xml", XML + f"""<p:cmAuthorLst {ns}><p:cmAuthor id="0" name="Presenter {MARK}" initials="PS" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>"""),
        ("ppt/comments/comment1.xml", XML + f"""<p:cmLst {ns}><p:cm authorId="0" dt="2024-05-03T08:00:00.000" idx="1"><p:pos x="10" y="10"/><p:text>Update the chart</p:text></p:cm></p:cmLst>"""),
        ("docProps/core.xml", core_xml("PowerPoint")),
        ("docProps/app.xml", app_xml("Microsoft Office PowerPoint", "<Words>2</Words><Slides>1</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides><PresentationFormat>Widescreen</PresentationFormat>")),
        ("docProps/custom.xml", CUSTOM),
        ("docProps/thumbnail.png", THUMB),
    ]
    write_zip("deck.pptx", parts)


# --------------------------------------------------------------------- ODF

ODF_NS = ('xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
          'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
          'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" '
          'xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" '
          'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" '
          'xmlns:officeooo="http://openoffice.org/2009/office" xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0"')
X = '<?xml version="1.0" encoding="UTF-8"?>\n'


def odf_meta(generator, stats):
    return X + f"""<office:document-meta {ODF_NS} office:version="1.2"><office:meta><meta:generator>{generator}</meta:generator><dc:title>Quarterly ODF report</dc:title><dc:description>Internal draft</dc:description><dc:subject>Finance</dc:subject><meta:keyword>finance</meta:keyword><meta:keyword>q3</meta:keyword><meta:initial-creator>Jane {MARK} Doe</meta:initial-creator><dc:creator>Bob {MARK}</dc:creator><meta:printed-by>Printer user {MARK}</meta:printed-by><meta:creation-date>2024-05-01T10:00:00.123456789</meta:creation-date><dc:date>2024-05-02T11:30:00</dc:date><meta:print-date>2024-05-03T07:00:00</meta:print-date><meta:template xlink:type="simple" xlink:actuate="onRequest" xlink:title="Letter" xlink:href="file:///home/{MARK}/Templates/Letter.ott" meta:date="2023-01-01T00:00:00"/><dc:language>en-US</dc:language><meta:editing-cycles>12</meta:editing-cycles><meta:editing-duration>PT1H2M3S</meta:editing-duration><meta:user-defined meta:name="Client">Client {MARK}</meta:user-defined><meta:user-defined meta:name="Budget" meta:value-type="float">12000.5</meta:user-defined><meta:user-defined meta:name="Approved" meta:value-type="boolean">true</meta:user-defined><meta:user-defined meta:name="Due" meta:value-type="date">2024-06-01</meta:user-defined><meta:document-statistic {stats}/></office:meta></office:document-meta>"""


def manifest(media, extra):
    entries = "".join(f'<manifest:file-entry manifest:full-path="{p}" manifest:media-type="{t}"/>' for p, t in extra)
    return X + f"""<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="{media}"/>{entries}</manifest:manifest>"""


SETTINGS = X + f"""<office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" office:version="1.2"><office:settings><config:config-item-set config:name="ooo:configuration-settings"><config:config-item config:name="PrinterName" config:type="string">HP LaserJet {MARK}</config:config-item><config:config-item config:name="PrinterSetup" config:type="base64Binary">{base64.b64encode(f"HP LaserJet {MARK} driver setup".encode()).decode()}</config:config-item><config:config-item config:name="RsidRoot" config:type="int">1234567</config:config-item><config:config-item config:name="Rsid" config:type="int">7654321</config:config-item><config:config-item config:name="PrintPaperFromSetup" config:type="boolean">false</config:config-item></config:config-item-set></office:settings></office:document-settings>"""


def rich_odt():
    parts = dict(read_zip(ODT))
    parts["meta.xml"] = odf_meta("LibreOffice/7.6.4.1$MacOSX_AARCH64 LibreOffice_project/e19e193f88cd6c0525a17fb7a176ed8e6a3e2aa1",
                                 'meta:table-count="0" meta:image-count="0" meta:object-count="0" meta:page-count="1" meta:paragraph-count="2" meta:word-count="9" meta:character-count="52"')
    parts["content.xml"] = X + f"""<office:document-content {ODF_NS} office:version="1.2"><office:automatic-styles><style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties officeooo:rsid="0012ab34" officeooo:paragraph-rsid="0012ab34"/></style:style><style:style style:name="T1" style:family="text"><style:text-properties officeooo:rsid="00ff00aa"/></style:style></office:automatic-styles><office:body><office:text><text:tracked-changes><text:changed-region xml:id="ct1" text:id="ct1"><text:insertion><office:change-info><dc:creator>Editor {MARK}</dc:creator><dc:date>2024-05-02T09:00:00</dc:date></office:change-info></text:insertion></text:changed-region></text:tracked-changes><text:p text:style-name="P1">Hello world, this is the body text.</text:p><text:p text:style-name="P1">Revenue grew <text:change-start text:change-id="ct1"/><text:span text:style-name="T1">strongly </text:span><text:change-end text:change-id="ct1"/>this quarter.<office:annotation><dc:creator>Reviewer {MARK}</dc:creator><dc:date>2024-05-03T08:00:00</dc:date><meta:creator-initials>RS</meta:creator-initials><text:p>Source for this figure?</text:p></office:annotation></text:p></office:text></office:body></office:document-content>"""
    parts["settings.xml"] = SETTINGS
    parts["Thumbnails/thumbnail.png"] = THUMB
    parts["META-INF/manifest.xml"] = manifest("application/vnd.oasis.opendocument.text", [
        ("content.xml", "text/xml"), ("styles.xml", "text/xml"), ("meta.xml", "text/xml"), ("settings.xml", "text/xml"),
        ("Thumbnails/thumbnail.png", "image/png")])
    order = ["mimetype", "content.xml", "styles.xml", "meta.xml", "settings.xml", "Thumbnails/thumbnail.png", "META-INF/manifest.xml"]
    write_zip("rich.odt", [(n, parts[n]) for n in order])


def ods():
    content = X + f"""<office:document-content {ODF_NS} office:version="1.2"><office:body><office:spreadsheet><table:table table:name="Sheet1"><table:table-row><table:table-cell office:value-type="string"><text:p>Revenue</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="1200"><text:p>1200</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>"""
    write_zip("sheet.ods", [
        ("mimetype", "application/vnd.oasis.opendocument.spreadsheet"),
        ("content.xml", content),
        ("meta.xml", odf_meta("LibreOffice/7.6", 'meta:table-count="1" meta:cell-count="2" meta:object-count="0"')),
        ("settings.xml", SETTINGS),
        ("META-INF/manifest.xml", manifest("application/vnd.oasis.opendocument.spreadsheet", [("content.xml", "text/xml"), ("meta.xml", "text/xml"), ("settings.xml", "text/xml")])),
    ])


def odp():
    content = X + f"""<office:document-content {ODF_NS} office:version="1.2"><office:body><office:presentation><draw:page draw:name="page1"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="3cm"><draw:text-box><text:p>Quarterly results</text:p></draw:text-box></draw:frame><office:annotation><dc:creator>Presenter {MARK}</dc:creator><dc:date>2024-05-03T08:00:00</dc:date><text:p>Update the chart</text:p></office:annotation></draw:page></office:presentation></office:body></office:document-content>"""
    write_zip("slides.odp", [
        ("mimetype", "application/vnd.oasis.opendocument.presentation"),
        ("content.xml", content),
        ("META-INF/manifest.xml", manifest("application/vnd.oasis.opendocument.presentation", [("content.xml", "text/xml")])),
    ])


# -------------------------------------------------------------------- EPUB

CONTAINER = X + """<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"""
COVER = png(24, 32, (200, 60, 40))


def chapter(title):
    return X + f"""<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title></head><body><h1>{title}</h1><p>It was a dark and stormy night.</p></body></html>"""


def epub2():
    opf = X + f"""<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uuid_id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf" xmlns:calibre="http://calibre.kovidgoyal.net/2009/metadata">
    <dc:title>The Stormy Night</dc:title>
    <dc:creator opf:role="aut" opf:file-as="Doe, Jane {MARK}">Jane {MARK} Doe</dc:creator>
    <dc:creator opf:role="ill">Ann Artist</dc:creator>
    <dc:contributor opf:role="bkp">calibre (6.29.0) [https://calibre-ebook.com]</dc:contributor>
    <dc:publisher>Publisher {MARK}</dc:publisher>
    <dc:date>2024-05-01T00:00:00+00:00</dc:date>
    <dc:description>A short story.</dc:description>
    <dc:subject>Fiction</dc:subject>
    <dc:subject>Weather</dc:subject>
    <dc:language>en</dc:language>
    <dc:identifier id="uuid_id" opf:scheme="uuid">urn:uuid:5ec4e7aa-0042-4242-9999-000000000042</dc:identifier>
    <dc:identifier opf:scheme="calibre">{MARK}-calibre-id</dc:identifier>
    <dc:identifier opf:scheme="ISBN">9780000000002</dc:identifier>
    <dc:rights>© 2024 Jane {MARK} Doe</dc:rights>
    <meta name="cover" content="cover"/>
    <meta name="calibre:timestamp" content="2024-05-01T10:00:00+00:00"/>
    <meta name="calibre:title_sort" content="Stormy Night, The"/>
    <meta name="calibre:author_link_map" content="{{&quot;Jane {MARK} Doe&quot;: &quot;&quot;}}"/>
    <meta name="calibre:user_metadata:#reader" content="Reader {MARK}"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover" href="cover.png" media-type="image/png"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="ch1"/></spine>
</package>"""
    ncx = X + f"""<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:5ec4e7aa-0042-4242-9999-000000000042"/><meta name="dtb:depth" content="1"/><meta name="dtb:generator" content="calibre (6.29.0)"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head><docTitle><text>The Stormy Night</text></docTitle><docAuthor><text>Jane {MARK} Doe</text></docAuthor><navMap><navPoint id="n1" playOrder="1"><navLabel><text>Chapter 1</text></navLabel><content src="chapter1.xhtml"/></navPoint></navMap></ncx>"""
    plist = X + f"""<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>com.apple.iTunesStore.downloadInfo</key><dict><key>accountInfo</key><dict><key>AppleID</key><string>buyer@{MARK}.example</string><key>FirstName</key><string>Jane</string></dict><key>purchaseDate</key><string>2024-05-01T10:00:00Z</string></dict><key>itemName</key><string>The Stormy Night</string></dict></plist>"""
    write_zip("book2.epub", [
        ("mimetype", "application/epub+zip"),
        ("META-INF/container.xml", CONTAINER),
        ("OEBPS/content.opf", opf),
        ("OEBPS/toc.ncx", ncx),
        ("OEBPS/chapter1.xhtml", chapter("Chapter 1")),
        ("OEBPS/cover.png", COVER),
        ("iTunesMetadata.plist", plist),
        ("META-INF/calibre_bookmarks.txt", f"encoding=json+base64:\n{MARK}-bookmark-data"),
    ])


def epub3():
    opf = X + f"""<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" prefix="calibre: https://calibre-ebook.com">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:5ec4e7aa-0042-4242-9999-000000000043</dc:identifier>
    <dc:identifier id="isbn">urn:isbn:9780000000002</dc:identifier>
    <dc:title id="t1">The Stormy Night</dc:title>
    <meta refines="#t1" property="title-type">main</meta>
    <dc:creator id="creator01">Jane {MARK} Doe</dc:creator>
    <meta refines="#creator01" property="role" scheme="marc:relators">aut</meta>
    <meta refines="#creator01" property="file-as">Doe, Jane {MARK}</meta>
    <dc:contributor id="contrib01">Editor {MARK}</dc:contributor>
    <meta refines="#contrib01" property="role" scheme="marc:relators">edt</meta>
    <dc:publisher>Publisher {MARK}</dc:publisher>
    <dc:date>2024-05-01</dc:date>
    <dc:subject>Fiction</dc:subject>
    <dc:description>A short story.</dc:description>
    <dc:language>en</dc:language>
    <dc:rights>© 2024 Jane {MARK} Doe</dc:rights>
    <dc:source>urn:isbn:9780000000001</dc:source>
    <meta property="dcterms:modified">2024-05-02T11:30:00Z</meta>
    <meta property="rendition:layout">reflowable</meta>
    <meta property="calibre:timestamp" scheme="dcterms:W3CDTF">2024-05-01T10:00:00+00:00</meta>
    <meta property="belongs-to-collection" id="c01">Weather Tales</meta>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>"""
    nav = X + """<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">Chapter 1</a></li></ol></nav></body></html>"""
    write_zip("book3.epub", [
        ("mimetype", "application/epub+zip"),
        ("META-INF/container.xml", CONTAINER),
        ("OEBPS/content.opf", opf),
        ("OEBPS/nav.xhtml", nav),
        ("OEBPS/chapter1.xhtml", chapter("Chapter 1")),
        ("OEBPS/images/cover.png", COVER),
    ])


rich_docx()
xlsx()
pptx()
rich_odt()
ods()
odp()
epub2()
epub3()
