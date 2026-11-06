import JSZip from 'jszip';

export type DocxPara =
  | { text: string }
  | { hyperlinkField: { url: string; display: string } }
  | { hyperlink: { url: string; display: string } }
  | { empty: true }
  | { lines: string[] }
  | { listItem: { text: string; level: number } };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const run = (t: string) => `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;

export async function makeDocx(paras: DocxPara[]): Promise<Buffer> {
  const rels: string[] = [];
  let usesNumbering = false;
  const body = paras
    .map((p) => {
      if ('empty' in p) return '<w:p/>';
      if ('lines' in p) return `<w:p>${p.lines.map(run).join('<w:r><w:br/></w:r>')}</w:p>`;
      if ('listItem' in p) {
        usesNumbering = true;
        return `<w:p><w:pPr><w:numPr><w:ilvl w:val="${p.listItem.level}"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(p.listItem.text)}</w:p>`;
      }
      if ('text' in p) return `<w:p>${run(p.text)}</w:p>`;
      if ('hyperlinkField' in p) {
        const { url, display } = p.hyperlinkField;
        return (
          '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
          `<w:r><w:instrText xml:space="preserve"> HYPERLINK "${esc(url)}" </w:instrText></w:r>` +
          '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
          `${run(display)}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
        );
      }
      const id = `rId${rels.length + 1}`;
      rels.push(
        `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(p.hyperlink.url)}" TargetMode="External"/>`,
      );
      return `<w:p><w:hyperlink r:id="${id}">${run(p.hyperlink.display)}</w:hyperlink></w:p>`;
    })
    .join('');

  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
  );
  if (usesNumbering) {
    zip.file(
      'word/numbering.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="*"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="-"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
    );
    zip.file(
      'word/_rels/document.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
    );
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
    );
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}
