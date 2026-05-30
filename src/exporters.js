import fs from 'node:fs';
import path from 'node:path';
import { columnName, escapeXml, zipStore } from './ooxml.js';

export const EXPORT_CAPABILITIES = new Set(['export_excel', 'export_execl', 'export_word', 'export_ppt']);

export function exportRows({ capability, format, outputPath, columns, rows, title = 'Export' }) {
  const resolvedCapability = normalizeCapability(capability || format || outputPath);
  if (!resolvedCapability) throw new Error(`Unsupported export capability: ${capability || format || outputPath}`);
  if (!outputPath) throw new Error('outputPath is required for export');
  const normalizedRows = normalizeRows(rows);
  const normalizedColumns = normalizeColumns(columns, normalizedRows);
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  if (resolvedCapability === 'export_excel') writeExcel(outputPath, normalizedColumns, normalizedRows);
  else if (resolvedCapability === 'export_word') writeWord(outputPath, normalizedColumns, normalizedRows, title);
  else if (resolvedCapability === 'export_ppt') writePpt(outputPath, normalizedColumns, normalizedRows, title);
  return {
    capability: resolvedCapability,
    outputPath: path.resolve(outputPath),
    rows: normalizedRows.length,
    columns: normalizedColumns.map((column) => column.title)
  };
}

export function normalizeCapability(value) {
  const text = String(value || '').toLowerCase();
  if (text === 'export_excel' || text === 'export_execl' || text === 'excel' || text === 'xlsx' || text.endsWith('.xlsx')) return 'export_excel';
  if (text === 'export_word' || text === 'word' || text === 'docx' || text.endsWith('.docx')) return 'export_word';
  if (text === 'export_ppt' || text === 'ppt' || text === 'pptx' || text.endsWith('.pptx')) return 'export_ppt';
  return '';
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => row && typeof row === 'object' && !Array.isArray(row) ? row : { value: row });
}

function normalizeColumns(columns, rows) {
  if (Array.isArray(columns) && columns.length) {
    return columns.map((column) => ({
      key: String(column.key || column.name || column.title),
      title: String(column.title || column.label || column.key || column.name)
    }));
  }
  const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  return keys.map((key) => ({ key, title: key }));
}

function values(columns, rows) {
  return [
    columns.map((column) => column.title),
    ...rows.map((row) => columns.map((column) => row[column.key] ?? ''))
  ];
}

function writeExcel(outputPath, columns, rows) {
  const sheet = worksheetXml(values(columns, rows));
  const files = {
    '[Content_Types].xml': excelContentTypesXml(),
    '_rels/.rels': rootRelsXml('xl/workbook.xml'),
    'xl/workbook.xml': workbookXml(),
    'xl/_rels/workbook.xml.rels': workbookRelsXml(),
    'xl/worksheets/sheet1.xml': sheet,
    'xl/styles.xml': excelStylesXml()
  };
  fs.writeFileSync(outputPath, zipStore(files));
}

function worksheetXml(table) {
  const body = table.map((row, rowIndex) => {
    const r = rowIndex + 1;
    const cells = row.map((value, columnIndex) => cellXml(columnName(columnIndex + 1), r, value)).join('');
    return `<row r="${r}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function cellXml(column, row, value) {
  const ref = `${column}${row}`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
}

function writeWord(outputPath, columns, rows, title) {
  const tableRows = values(columns, rows).map((row) => (
    `<w:tr>${row.map((cell) => `<w:tc><w:p><w:r><w:t>${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`
  )).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${escapeXml(title)}</w:t></w:r></w:p><w:tbl>${tableRows}</w:tbl><w:sectPr/></w:body></w:document>`;
  const files = {
    '[Content_Types].xml': wordContentTypesXml(),
    '_rels/.rels': rootRelsXml('word/document.xml'),
    'word/document.xml': document
  };
  fs.writeFileSync(outputPath, zipStore(files));
}

function writePpt(outputPath, columns, rows, title) {
  const lines = values(columns, rows).slice(0, 15).map((row) => row.join(' | '));
  const paragraphs = [title, ...lines].map((line, index) => (
    `<a:p><a:r><a:rPr lang="zh-CN" sz="${index === 0 ? 2800 : 1400}"/><a:t>${escapeXml(line)}</a:t></a:r></a:p>`
  )).join('');
  const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Content"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="5943600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  const files = {
    '[Content_Types].xml': pptContentTypesXml(),
    '_rels/.rels': rootRelsXml('ppt/presentation.xml'),
    'ppt/presentation.xml': presentationXml(),
    'ppt/_rels/presentation.xml.rels': presentationRelsXml(),
    'ppt/slides/slide1.xml': slide
  };
  fs.writeFileSync(outputPath, zipStore(files));
}

function excelContentTypesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
}

function wordContentTypesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
}

function pptContentTypesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>';
}

function rootRelsXml(target) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;
}

function workbookXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="export" sheetId="1" r:id="rId1"/></sheets></workbook>';
}

function workbookRelsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
}

function excelStylesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>';
}

function presentationXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>';
}

function presentationRelsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>';
}
