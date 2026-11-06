import JSZip from 'jszip';

export type DocxPara =
  | { text: string }
  | { hyperlinkField: { url: string; display: string } }
  | { hyperlink: { url: string; display: string } }
  | { empty: true };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const run = (t: string) => `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;

export async function makeDocx(paras: DocxPara[]): Promise<Buffer> {
  const rels: string[] = [];
  const body = paras
    .map((p) => {
      if ('empty' in p) return '<w:p/>';
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
  return zip.generateAsync({ type: 'nodebuffer' });
}
