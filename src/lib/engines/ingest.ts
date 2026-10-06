// ============================================================
// Openmukti Audiobook Creator — intelligent local file ingestion
// Reads files in-browser (NEVER uploads). 900+ known extensions
// dispatched to smart per-category converters producing speakable text.
// ============================================================
import type { IngestCategory, IngestResult, IngestTextKind, OcrOptions } from '@/lib/types';
import { yieldToUI } from '@/lib/utils/async';
import { parseZip, readZipEntryText, type ZipEntry } from '@/lib/engines/zip';
import { extractPdfText } from '@/lib/engines/pdf';
import { extractStrings, guessBinaryKind, hexDump, shannonEntropy } from '@/lib/engines/strings';
import { runOcrOnImage, runOcrOnVideoFile } from '@/lib/engines/ocr';
import { ocrPdfToText } from '@/lib/engines/pdf-ocr';
import { formatBytes } from '@/lib/utils/format';

// ---------- extension database (grouped for readability) ----------
const TEXT_EXTS = 'txt text md markdown mdown mkd rst adoc asciidoc org creole wiki txt2tags pod nfo info readme me changelog license authors contributing todo news install notice version release notes log log1 log2 srt vtt srt2 sbv sub ass ssa lrc smi cap dfxp ttml xml-ui json5 jo bib ris enw conf cfg cnf ini env properties plist strings po pot mo xlf xliff yml yt outlook msg decl htpasswd htaccess gitignore gitattributes editorconfig npmrc babelrc eslintrc prettierrc dockerfile makefile cmakelists gradle sbt properties2 csv2 tsv2 dsv psv'.split(' ');
const CODE_EXTS = ('js jsx mjs cjs ts tsx mts cts dts json jsonc jsonld map webmanifest d.ts vue svelte astro ' +
  'py pyw pyi pyx pxd rpy ipynb pyde gyp gypi rb rake gemspec ru erl hrl ex exs eex leex heex ' +
  'java class jav kt kts scala sc go rs c h cpp cc cxx hpp hh hxx c++ h++ cs fs fsx fsi vb vbs bas frm cls ' +
  'm mm swift dart groovy gradle jl r rmd sas stata do ado pl pm pod6 t php php3 php4 php5 phtml phar psql ' +
  'sql ddl dml prc trc fnc ps1 psm1 psd1 bat cmd sh bash zsh fish ksh csh tcsh awk sed vim elm hs lhs ' +
  'ml mli fsproj clj cljs cljc edn egi lisp lsp el scm ss rkt racket asm s nasm masm inc ada adb ads ' +
  'f for f90 f95 f03 f08 cob cbl pas dpr dproj pp puppet epp hcl tf tfvars proto graphql gql thrift ' +
  'capnp avro idl wit wat wasm-text sol vy move cairo circom zig nim rlib v sv svh vhd vhdl vhdl2 ' +
  'verilo vg v2 tcl itcl adoc-codecoffee gleam deno bang cmdletworkflow work').split(' ').filter((x, i, a) => a.indexOf(x) === i);
const DATA_EXTS = 'csv tsv psv dsv json jsonl ndjson geojson topojson arrow parquet orc avro xml xml2 rss atom opml xhtml xht xsd xsl xslt dtd yaml yml toml tml ini cfg conf cnf properties env reg ics vcf vcard kml gpx tcx fit fit2 srt3 ttl n3 nt rdf owl sparql rq cypher gexf graphml dot gv neato ps prn hprof jfr har pcap pcapng ng dump bak backup tmp old orig patch diff rej log4j properties3 sqlite2 db2 mdb accdb dbf ldb sdf mdf ndf registry hive pol manifest catalog cab-inf'.split(' ');
const DOC_EXTS = 'doc docx docm dot dotx dotm docb rtf odt ott fodt uot wri wpd wps wpt hwp hwpx pages pages-tef tex latex ltx cls sty bst dtx ltx2 sgm sgml dita ditamap ditaval xmind xhtml-wiki mdx mdoc groff man roff 1 2 3 4 5 6 7 8 9 pdf ps eps ai2 cdr ccx vsd vsdx vdx pub xps oxps cbz cbr cb7 cbt djvu ps2 ps3 lit prc mobi azw azw3 azw4 kfx kobo epub epub3 ibooks fb2 fbz pdb texinfo info chm hxs hxi hhi din oth'.split(' ');
const IMAGE_EXTS = 'png jpg jpeg jpe jfif jif jp2 j2k jpf jpx jpm jxl jpg2 webp avif heic heif heif2 hif gif gifv bmp dib dip tif tiff tif2 psd psb pdd xcf xcfgz xcfbz2 pdd2 pns exr hdr pic tga icb vda vst sgi rgb bw iris ppm pgm pbm pnm pam rpf ras sun im8 img pcx dcx dds ktx ktx2 astc pvr ttm svg svgz eps-ai cdr2 cmx wpg svs ndpi vms vmu scn mrxs nifti nii gz2 dicom dicom2 dcm nrrd mip ptx afm2 thm'.split(' ').filter((x, i, a) => a.indexOf(x) === i);
const VIDEO_EXTS = 'mp4 m4v m4p mp4v mpg mpeg mp2 mpe mpv m2v m1v m2p m2t m2ts ts tsp trp mts vob evo 3gp 3g2 3gpp 3gpp2 mxf roq mkv mk3d mka webm avi avii vfw divx xvid flv f4v f4p f4a f4b swf wmv wmp wm wmd asf asx mov qt movie m4u m4ud mqv mqv ogv ogm gxv rv rm rmvb ram rpm smk bik bik2 vp6 vp7 yuv y4m nut dv dif amv nsv trp-gxf gxf lxf hkm pmp spl dcr dir dxr vr gym mjpeg mjpg cprd'.split(' ').filter((x, i, a) => a.indexOf(x) === i);
const AUDIO_EXTS = 'mp3 mp2 mp1 mpa m4a m4b m4r aac aacp adts aa aax ac3 eac3 dts dtshd dtsma spx opus ogg oga ogx vorbis wav wave w64 bwf rf64 aif aiff aifc aifc2 afl au snd sndr ulaw alaw gsm voc vox raw pcm s16 s24 s32 f32 flac fla flac2 mka mka2 mpc mp+ ape mac wv wvc ofr ofs ofs2 opt la pac shn tta tak mus mka3 dff dsf dsdiff wma wm m4p2 aa3 omg atm at3 vqf wvx wmx wax m3u m3u8 pls asx xpl cue log2-audio cdda cda mid midi rmi kar abs mka4'.split(' ').filter((x, i, a) => a.indexOf(x) === i);
const ARCHIVE_EXTS = 'zip zipx z01 z02 zx01 zx02 jar war ear apk aab ipa xapk apks hap 7z 7z001 7z002 rar r00 r01 r02 part1 part2 arj lzh lha lzx cab msi msp msu tar tar2 tgz tbz tbz2 txz tzst tlz tz tar.gz tar.bz2 tar.xz tar.zst tar.lz4 bz2 bz xz zst lz4 lz lzma gz gzip z br brotli zz a ar cpio shar shar2 squashfs img-arc dmg iso img vhd vhdi vdi vmdk qcow qcow2 crx xpi whl egg gem npm deb rpm pkg pkgbuild mpkg slp snap flatpak appimage run pack pack200'.split(' ').filter((x, i, a) => a.indexOf(x) === i);
const BINARY_EXTS = 'exe com sys dll ocx cpl scr drv so dylib 1.so bin dat pdt pkg pkg2 bundle app framework kext lib a lib2 obj o ko nlm vxd 386 s19 srec hex ihex elf2 axf rom bin2 iso2 cue2 toast mds mdf nrg ccd sub img3 imd dmg2 sparseimage sparsebundle wim swm esd fhdir vhd2 avhdx chk hiberfil pagefile swapfile dumps pdb2 idb map2 objdump ttf otf woff woff2 eot fon bdf pcf snf sfd ufo glyphs otc ttc cff ps2 pfb pfm afm cmap'.split(' ').filter((x, i, a) => a.indexOf(x) === i);

function buildDb(): Record<string, IngestCategory> {
  const db: Record<string, IngestCategory> = {};
  const add = (list: string[], cat: IngestCategory) => {
    for (const e of list) {
      const k = e.toLowerCase().replace(/\./g, '').trim();
      if (k && !(k in db)) db[k] = cat;
    }
  };
  add(TEXT_EXTS, 'text');
  add(CODE_EXTS, 'code');
  add(DATA_EXTS, 'data');
  add(DOC_EXTS, 'document');
  add(IMAGE_EXTS, 'image');
  add(VIDEO_EXTS, 'video');
  add(AUDIO_EXTS, 'audio');
  add(ARCHIVE_EXTS, 'archive');
  add(BINARY_EXTS, 'binary');
  return db;
}

export const EXTENSION_DATABASE: Record<string, IngestCategory> = buildDb();

export function categorizeFile(fileName: string): { category: IngestCategory; handler: string } {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const category = EXTENSION_DATABASE[ext] ?? 'unknown';
  const handlers: Record<IngestCategory, string> = {
    text: 'plain-text reader',
    code: 'source-code reader',
    data: 'structured-data converter',
    document: 'document extractor',
    image: 'image inspector + OCR',
    video: 'video inspector + frame OCR',
    audio: 'audio metadata decoder',
    archive: 'archive content lister',
    binary: 'binary strings + entropy analyzer',
    unknown: 'generic binary analyzer',
  };
  return { category, handler: handlers[category] };
}

export function getSupportedExtensionCount(): number {
  return Object.keys(EXTENSION_DATABASE).length;
}

export function knownExtensions(): string[] {
  return Object.keys(EXTENSION_DATABASE);
}

// ---------- helpers ----------
function introSentence(file: File, kindLabel: string): string {
  return `${kindLabel} "${file.name}", size ${formatBytes(file.size)}.`;
}

function cleanText(t: string): string {
  return t
    .replace(/\r\n?/g, '\n')
    .replace(/\uFEFF/g, '')
    .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬀ/g, 'ff').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

async function readTextSmart(file: File): Promise<string> {
  const buf = await file.slice(0, Math.min(file.size, 32 * 1024 * 1024)).arrayBuffer();
  const u8 = new Uint8Array(buf);
  // BOMs
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8);
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.slice(3));
  // UTF-16 heuristic: many zero bytes at odd positions
  let zeros = 0;
  const check = Math.min(u8.length, 2048);
  for (let i = 1; i < check; i += 2) if (u8[i] === 0) zeros++;
  if (zeros > check / 4) return new TextDecoder('utf-16le').decode(u8);
  return new TextDecoder('utf-8', { fatal: false }).decode(u8);
}

function fmtTable(headers: string[], rows: string[][], maxRows = 60): string {
  const h = headers.map((x, i) => x || `column ${i + 1}`);
  const parts: string[] = [`Table with ${h.length} columns: ${h.join(', ')}.`];
  const cap = Math.min(rows.length, maxRows);
  for (let r = 0; r < cap; r++) {
    const cells = rows[r].slice(0, 12);
    parts.push(`Row ${r + 1}: ` + cells.map((v, i) => `${h[i] ?? `column ${i + 1}`} is ${v || 'empty'}`).join(', ') + '.');
  }
  if (rows.length > cap) parts.push(`… ${rows.length - cap} more rows omitted.`);
  return parts.join('\n');
}

function jsonToSpeech(value: unknown, keyName = 'root', depth = 0): string {
  const pad = '  '.repeat(depth);
  if (value === null) return `${keyName} is null.`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${keyName} is an empty list.`;
    const cap = Math.min(value.length, 8);
    const items = value.slice(0, cap).map((v, i) => jsonToSpeech(v, `item ${i + 1}`, depth + 1));
    const summary = `${keyName} is a list containing ${value.length} item${value.length === 1 ? '' : 's'}.`;
    const rest = value.length > cap ? `\n${pad}… ${value.length - cap} more items.` : '';
    return `${summary}\n${items.join('\n')}${rest}`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${keyName} is an empty object.`;
    const cap = Math.min(entries.length, 20);
    const lines = entries.slice(0, cap).map(([k, v]) => {
      if (v === null || typeof v !== 'object') return `${pad}${k}: ${String(v)}`;
      return jsonToSpeech(v, k, depth + 1);
    });
    return `${keyName} is an object with ${entries.length} keys.\n${lines.join('\n')}`;
  }
  return `${keyName}: ${String(value)}`;
}

function parseCsv(text: string, delimiter: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) { cur.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      cur.push(field); field = '';
      if (cur.some((x) => x !== '')) rows.push(cur);
      cur = [];
    } else field += c;
  }
  cur.push(field);
  if (cur.some((x) => x !== '')) rows.push(cur);
  const headers = rows.shift() ?? [];
  return { headers, rows };
}

function xmlToSpeech(xml: string, maxDepth = 12): string {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) return '';
    const out: string[] = [];
    const walk = (node: Element, depth: number) => {
      if (depth > maxDepth) return;
      const ownText = Array.from(node.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
      const attrs = Array.from(node.attributes);
      if (attrs.length && !ownText) {
        out.push(`${'  '.repeat(depth)}${node.nodeName}: ` + attrs.map((a) => `${a.name} is ${a.value}`).join(', '));
      } else if (ownText) {
        out.push(`${'  '.repeat(depth)}${node.nodeName}: ${ownText}`);
      } else {
        out.push(`${'  '.repeat(depth)}${node.nodeName}:`);
      }
      for (const child of Array.from(node.children)) walk(child, depth + 1);
    };
    const root = doc.documentElement;
    if (root) walk(root, 0);
    return out.join('\n');
  } catch {
    return '';
  }
}

function rtfToText(rtf: string): string {
  return rtf
    .replace(/\\'([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\{\\\*[^}]*\}/g, '')
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\line\b/g, '\n')
    .replace(/\\tab\b/g, '\t')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .trim();
}

function htmlToText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, noscript, svg, nav, footer, head').forEach((el) => el.remove());
    const main = doc.querySelector('main, article, [role="main"]') ?? doc.body;
    if (!main) return '';
    const blocks: string[] = [];
    main.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, td, th, pre, blockquote').forEach((el) => {
      const t = el.textContent?.replace(/\s+/g, ' ').trim();
      if (t && t.length > 1) {
        const tag = el.tagName.toLowerCase();
        blocks.push(/^h[1-6]$/.test(tag) ? `\n## ${t}` : tag === 'li' ? `- ${t}` : t);
      }
    });
    const text = blocks.join('\n');
    return text || (main.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  } catch {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  }
}

function subtitleToScript(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^\d+$/.test(t)) return false;
      if (/^\d{2}:\d{2}(:\d{2})?[.,]\d{3}\s*-->/.test(t)) return false;
      if (/^(WEBVTT|NOTE|STYLE|REGION)/i.test(t)) return false;
      return true;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function logToSummary(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim());
  const levels = { error: 0, warn: 0, info: 0, debug: 0 };
  for (const l of lines) {
    if (/\b(error|err|fatal|critical)\b/i.test(l)) levels.error++;
    else if (/\b(warn|warning)\b/i.test(l)) levels.warn++;
    else if (/\b(info)\b/i.test(l)) levels.info++;
    else if (/\b(debug|trace)\b/i.test(l)) levels.debug++;
  }
  const parts = [
    `Log file with ${lines.length} entries.`,
    `Levels: ${levels.error} errors, ${levels.warn} warnings, ${levels.info} info, ${levels.debug} debug.`,
  ];
  const errs = lines.filter((l) => /\b(error|fatal|critical)\b/i.test(l)).slice(0, 20);
  if (errs.length) parts.push('Notable errors:\n' + errs.join('\n'));
  else parts.push('First lines:\n' + lines.slice(0, 15).join('\n'));
  if (lines.length > 15) parts.push('Last lines:\n' + lines.slice(-10).join('\n'));
  return parts.join('\n\n');
}

// ---------- DOCX / XLSX / PPTX / EPUB via zip ----------
async function docxToText(buf: ArrayBuffer): Promise<string> {
  const { entries } = parseZip(buf);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) throw new Error('Not a valid DOCX (missing word/document.xml)');
  const xml = await readZipEntryText(buf, doc);
  const dom = new DOMParser().parseFromString(xml, 'text/xml');
  const paras = Array.from(dom.getElementsByTagName('w:p'));
  const out: string[] = [];
  for (const p of paras) {
    const texts = Array.from(p.getElementsByTagName('w:t')).map((t) => t.textContent ?? '');
    const joined = texts.join('').trim();
    if (joined) out.push(joined);
  }
  return out.join('\n\n');
}

async function xlsxToText(buf: ArrayBuffer): Promise<string> {
  const { entries } = parseZip(buf);
  const sharedEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  const shared: string[] = [];
  if (sharedEntry) {
    const xml = await readZipEntryText(buf, sharedEntry);
    const dom = new DOMParser().parseFromString(xml, 'text/xml');
    for (const si of Array.from(dom.getElementsByTagName('si'))) {
      shared.push(Array.from(si.getElementsByTagName('t')).map((t) => t.textContent ?? '').join(''));
    }
  }
  const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).slice(0, 5);
  const out: string[] = [];
  for (const sheet of sheets) {
    const xml = await readZipEntryText(buf, sheet);
    const dom = new DOMParser().parseFromString(xml, 'text/xml');
    const rows = Array.from(dom.getElementsByTagName('row'));
    const name = sheet.name.replace('xl/worksheets/', '').replace('.xml', '');
    out.push(`Sheet ${name}:`);
    for (const row of rows.slice(0, 60)) {
      const cells = Array.from(row.getElementsByTagName('c'));
      const vals = cells.map((c) => {
        const type = c.getAttribute('t');
        const vNode = c.getElementsByTagName('v')[0]?.textContent ?? '';
        const isNode = c.getElementsByTagName('is')[0];
        if (type === 's') return shared[parseInt(vNode)] ?? vNode;
        if (type === 'inlineStr' && isNode) return Array.from(isNode.getElementsByTagName('t')).map((t) => t.textContent ?? '').join('');
        return vNode;
      });
      if (vals.some((v) => v !== '')) out.push('Row: ' + vals.filter((v) => v !== '').join(', '));
    }
  }
  return out.join('\n');
}

async function pptxToText(buf: ArrayBuffer): Promise<string> {
  const { entries } = parseZip(buf);
  const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => (parseInt(a.name.match(/\d+/)?.[0] ?? '0')) - (parseInt(b.name.match(/\d+/)?.[0] ?? '0')));
  const out: string[] = [];
  for (const slide of slides) {
    const xml = await readZipEntryText(buf, slide);
    const dom = new DOMParser().parseFromString(xml, 'text/xml');
    const texts = Array.from(dom.getElementsByTagName('a:t')).map((t) => t.textContent ?? '').filter((t) => t.trim());
    out.push(`Slide ${out.length + 1}:\n` + texts.join('\n'));
  }
  return out.join('\n\n');
}

async function epubToText(buf: ArrayBuffer): Promise<string> {
  const { entries } = parseZip(buf);
  const container = entries.find((e) => e.name === 'META-INF/container.xml');
  let opfPath = '';
  if (container) {
    const xml = await readZipEntryText(buf, container);
    opfPath = xml.match(/full-path="([^"]+)"/)?.[1] ?? '';
  }
  let order: string[] = [];
  if (opfPath) {
    const opf = entries.find((e) => e.name === opfPath);
    if (opf) {
      const xml = await readZipEntryText(buf, opf);
      const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
      order = Array.from(xml.matchAll(/idref="([^"]+)"/g)).map((m) => m[1]);
      const idToHref = new Map(Array.from(xml.matchAll(/<item\b[^>]*id="([^"]+)"[^>]*href="([^"]+)"/g)).map((m) => [m[1], m[2]]));
      // fallback attribute order
      for (const m of xml.matchAll(/<item\b([^>]*)>/g)) {
        const id = m[1].match(/id="([^"]+)"/)?.[1];
        const href = m[1].match(/href="([^"]+)"/)?.[1];
        if (id && href) idToHref.set(id, href);
      }
      order = order.map((id) => idToHref.get(id) ?? '').filter(Boolean).map((h) => baseDir + h);
    }
  }
  const docs = order.length ? order : entries.filter((e) => /\.x?html?$/i.test(e.name)).map((e) => e.name);
  const out: string[] = [];
  for (const name of docs.slice(0, 40)) {
    const entry = entries.find((e) => e.name === name);
    if (!entry) continue;
    const html = await readZipEntryText(buf, entry);
    const text = htmlToText(html);
    if (text) out.push(text);
  }
  return out.join('\n\n');
}

async function odtToText(buf: ArrayBuffer): Promise<string> {
  const { entries } = parseZip(buf);
  const content = entries.find((e) => e.name === 'content.xml');
  if (!content) throw new Error('Not a valid ODT (missing content.xml)');
  const xml = await readZipEntryText(buf, content);
  const dom = new DOMParser().parseFromString(xml, 'text/xml');
  const paras = Array.from(dom.getElementsByTagName('text:p'));
  return paras.map((p) => p.textContent?.trim() ?? '').filter(Boolean).join('\n\n');
}

// ---------- main dispatcher ----------
export async function ingestFile(
  file: File,
  opts?: { ocr?: OcrOptions; pdfOcr?: OcrOptions; onProgress?: (p: number, msg?: string) => void },
): Promise<IngestResult> {
  const t0 = performance.now();
  const onProgress = opts?.onProgress;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const { category, handler } = categorizeFile(file.name);
  let text = '';
  let textKind: IngestTextKind = 'none';
  const warnings: string[] = [];
  const metadata: Record<string, string | number | boolean> = {
    size: file.size,
    lastModified: file.lastModified,
    extension: ext,
    handler,
  };
  let ocrSuggested = false;

  try {
    onProgress?.(0.05, `Reading ${file.name} (${formatBytes(file.size)})`);

    switch (category) {
      case 'text':
      case 'code': {
        const raw = await readTextSmart(file);
        onProgress?.(0.5, 'Cleaning text');
        text = ext === 'srt' || ext === 'vtt' || ext === 'sbv' || ext === 'sub' || ext === 'ass' || ext === 'ssa'
          ? subtitleToScript(raw)
          : cleanText(raw);
        textKind = ext === 'srt' || ext === 'vtt' ? 'converted' : 'plain';
        if (category === 'code') {
          text = `Source file: ${file.name} (${ext.toUpperCase() || 'code'} source).\n\n` + text;
        }
        metadata.characters = text.length;
        break;
      }

      case 'data': {
        const raw = await readTextSmart(file);
        onProgress?.(0.4, 'Parsing structured data');
        if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson' || ext === 'jsonc' || ext === 'geojson' || ext === 'topojson') {
          try {
            if (ext === 'jsonl' || ext === 'ndjson') {
              const lines = raw.split('\n').filter((l) => l.trim()).slice(0, 50);
              text = lines.map((l, i) => jsonToSpeech(JSON.parse(l), `record ${i + 1}`)).join('\n');
            } else {
              text = jsonToSpeech(JSON.parse(raw));
            }
            textKind = 'converted';
          } catch {
            warnings.push('Malformed JSON — reading as plain text');
            text = cleanText(raw);
            textKind = 'plain';
          }
        } else if (ext === 'csv' || ext === 'tsv' || ext === 'psv' || ext === 'dsv') {
          const delim = ext === 'tsv' ? '\t' : ext === 'psv' ? '|' : ext === 'dsv' ? (raw.includes(';') ? ';' : ',') : ',';
          const { headers, rows } = parseCsv(raw, delim);
          text = fmtTable(headers, rows);
          textKind = 'converted';
          metadata.rows = rows.length;
          metadata.columns = headers.length;
        } else if (ext === 'xml' || ext === 'rss' || ext === 'atom' || ext === 'opml' || ext === 'xsd' || ext === 'kml' || ext === 'svg') {
          text = xmlToSpeech(raw);
          if (!text) {
            warnings.push('XML could not be parsed — reading as plain text');
            text = cleanText(raw);
            textKind = 'plain';
          } else textKind = 'converted';
        } else if (ext === 'yml' || ext === 'yaml' || ext === 'toml' || ext === 'ini' || ext === 'cfg' || ext === 'conf' || ext === 'env' || ext === 'properties') {
          const lines = raw.split('\n').filter((l) => l.trim() && !/^[#;\[]/.test(l.trim()));
          const out: string[] = [];
          let indent = 0;
          for (const line of lines.slice(0, 400)) {
            const lead = line.match(/^\s*/)?.[0].length ?? 0;
            const content = line.trim().replace(/^-\s*/, '').replace(/[=:]\s*/, ' is ');
            if (lead < indent) indent = lead;
            out.push(`${'  '.repeat(Math.min(4, Math.floor(lead / 2)))}${content}`);
          }
          text = `Configuration data (${ext.toUpperCase()}):\n` + out.join('\n');
          textKind = 'converted';
        } else if (ext === 'log' || ext === 'log1' || ext === 'log2' || ext === 'out' || ext === 'dump') {
          text = logToSummary(raw);
          textKind = 'converted';
        } else if (ext === 'sql') {
          const stmts = raw.split(/;\s*\n/).filter((s) => s.trim()).slice(0, 100);
          text = `SQL script with ${stmts.length} statements.\n` + stmts.map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 300)).join(';\n');
          textKind = 'converted';
        } else {
          text = cleanText(raw);
          textKind = 'plain';
        }
        break;
      }

      case 'document': {
        const buf = await file.arrayBuffer();
        onProgress?.(0.35, `Extracting ${ext.toUpperCase()} content`);
        if (ext === 'docx' || ext === 'docm') {
          text = await docxToText(buf);
          textKind = 'extracted';
          metadata.format = 'Office Open XML (DOCX)';
        } else if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xlsb') {
          text = await xlsxToText(buf);
          textKind = 'extracted';
          metadata.format = 'Office Open XML (XLSX)';
        } else if (ext === 'pptx' || ext === 'pptm') {
          text = await pptxToText(buf);
          textKind = 'extracted';
          metadata.format = 'Office Open XML (PPTX)';
        } else if (ext === 'epub' || ext === 'epub3') {
          text = await epubToText(buf);
          textKind = 'extracted';
          metadata.format = 'EPUB e-book';
        } else if (ext === 'odt' || ext === 'ott' || ext === 'fodt') {
          text = await odtToText(buf);
          textKind = 'extracted';
          metadata.format = 'OpenDocument Text';
        } else if (ext === 'pdf') {
          const pdf = await extractPdfText(buf, (p) => onProgress?.(0.3 + p * 0.5, 'Scanning PDF streams'));
          if (pdf.ok) {
            text = pdf.text;
            textKind = 'extracted';
            metadata.pages = pdf.pages;
          } else if (opts?.pdfOcr) {
            warnings.push(pdf.warning ?? 'PDF text extraction failed — switching to local page OCR.');
            ocrSuggested = true;
            onProgress?.(0.78, 'No text layer — rendering PDF pages for local OCR');
            const ocr = await ocrPdfToText(file, {
              ...opts.pdfOcr,
              onProgress: (p, m) => onProgress?.(0.78 + p * 0.21, m ?? 'OCR on PDF pages'),
            });
            if (ocr.text.trim()) {
              text = cleanText(ocr.text);
              textKind = 'ocr';
              metadata.pages = ocr.pages;
              metadata.ocrConfidence = +(ocr.avgConfidence * 100).toFixed(1);
              metadata.ocrEngine = 'Tesseract.js LSTM (local)';
              warnings.push(`Automatic local OCR recovered text from ${ocr.pages} PDF pages.`);
            } else {
              warnings.push('Local PDF OCR found no readable text.');
            }
          } else {
            warnings.push(pdf.warning ?? 'PDF text extraction failed');
            ocrSuggested = true;
          }
        } else if (ext === 'rtf') {
          text = rtfToText(await readTextSmart(file));
          textKind = 'extracted';
        } else if (ext === 'html' || ext === 'htm' || ext === 'xhtml' || ext === 'mdx' || ext === 'mht' || ext === 'mhtml') {
          text = htmlToText(await readTextSmart(file));
          textKind = 'extracted';
        } else if (ext === 'tex' || ext === 'latex' || ext === 'ltx') {
          const raw = await readTextSmart(file);
          text = raw
            .replace(/\\begin\{(document|itemize|enumerate|table|figure)\*?\}/g, '')
            .replace(/\\end\{(document|itemize|enumerate|table|figure)\*?\}/g, '')
            .replace(/\\(sub)*section\*?\{([^}]*)\}/g, '\n## $2')
            .replace(/\\item\s/g, '- ')
            .replace(/%.*$/gm, '')
            .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
            .replace(/[{}]/g, '')
            .trim();
          textKind = 'extracted';
        } else if (ext === 'srt' || ext === 'vtt') {
          text = subtitleToScript(await readTextSmart(file));
          textKind = 'converted';
        } else {
          warnings.push(`No dedicated parser for .${ext} documents — attempting plain-text read`);
          const raw = await readTextSmart(file);
          const printable = raw.replace(/[^\x20-\x7E\n\t]/g, '').length / Math.max(1, raw.length);
          if (printable > 0.7) {
            text = cleanText(raw);
            textKind = 'plain';
          } else {
            const strings = extractStrings(new Uint8Array(buf), { minLen: 8, maxStrings: 300 });
            text = strings.slice(0, 200).join('\n');
            textKind = 'strings';
          }
        }
        break;
      }

      case 'image': {
        onProgress?.(0.3, 'Decoding image');
        try {
          const bmp = await createImageBitmap(file);
          metadata.width = bmp.width;
          metadata.height = bmp.height;
          metadata.megapixels = +((bmp.width * bmp.height) / 1e6).toFixed(2);
          metadata.aspectRatio = +(bmp.width / bmp.height).toFixed(3);
          text = introSentence(file, 'Image') + ` Dimensions ${bmp.width}×${bmp.height} pixels.`;
          bmp.close?.();
        } catch {
          text = introSentence(file, 'Image');
          warnings.push('Image could not be decoded in this browser');
        }
        if (opts?.ocr) {
          onProgress?.(0.5, 'Running local OCR');
          const ocr = await runOcrOnImage(file, opts.ocr);
          if (ocr.text.trim()) {
            text = ocr.text.trim();
            textKind = 'ocr';
            metadata.ocrConfidence = +(ocr.avgConfidence * 100).toFixed(1);
          } else {
            warnings.push('No readable text detected in image');
          }
        } else {
          ocrSuggested = true;
        }
        break;
      }

      case 'video': {
        onProgress?.(0.2, 'Inspecting video metadata');
        const url = URL.createObjectURL(file);
        try {
          const meta = await new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
            const v = document.createElement('video');
            v.preload = 'metadata';
            v.onloadedmetadata = () => resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
            v.onerror = () => reject(new Error('Video metadata not supported for this codec'));
            v.src = url;
            setTimeout(() => reject(new Error('Video metadata timeout')), 8000);
          });
          metadata.durationSec = +meta.duration.toFixed(2);
          metadata.width = meta.width;
          metadata.height = meta.height;
          text = `Video "${file.name}", duration ${Math.floor(meta.duration / 60)} minutes ${Math.floor(meta.duration % 60)} seconds, resolution ${meta.width} by ${meta.height}.`;
        } catch (e) {
          text = introSentence(file, 'Video');
          warnings.push(e instanceof Error ? e.message : 'Video inspection failed');
        } finally {
          URL.revokeObjectURL(url);
        }
        if (opts?.ocr) {
          onProgress?.(0.4, 'Sampling video frames for OCR');
          const ocr = await runOcrOnVideoFile(file, { ...opts.ocr, onProgress: (p, m) => onProgress?.(0.4 + p * 0.5, m ?? 'OCR on frames') });
          if (ocr.text.trim()) {
            text = ocr.text.trim();
            textKind = 'ocr';
            metadata.framesAnalyzed = ocr.framesAnalyzed;
          } else {
            warnings.push('No readable text found in sampled video frames');
          }
        } else {
          ocrSuggested = true;
        }
        break;
      }

      case 'audio': {
        onProgress?.(0.3, 'Decoding audio metadata');
        try {
          const ac = new AudioContext();
          const buf = await file.slice(0, Math.min(file.size, 60 * 1024 * 1024)).arrayBuffer();
          const audio = await ac.decodeAudioData(buf);
          metadata.durationSec = +audio.duration.toFixed(2);
          metadata.sampleRate = audio.sampleRate;
          metadata.channels = audio.numberOfChannels;
          text = `Audio file "${file.name}", duration ${Math.floor(audio.duration / 60)} minutes ${Math.floor(audio.duration % 60)} seconds, sample rate ${audio.sampleRate} hertz, ${audio.numberOfChannels === 1 ? 'mono' : 'stereo'}.`;
          void ac.close();
        } catch {
          text = introSentence(file, 'Audio');
          warnings.push('Audio codec not decodable in this browser — metadata only');
        }
        break;
      }

      case 'archive': {
        onProgress?.(0.4, 'Listing archive contents');
        try {
          const buf = await file.slice(0, Math.min(file.size, 64 * 1024 * 1024)).arrayBuffer();
          const { entries, warning } = parseZip(buf);
          if (warning) warnings.push(warning);
          const files = entries.filter((e) => !e.isDir);
          const totalUncompressed = files.reduce((a, e) => a + e.size, 0);
          metadata.entries = files.length;
          metadata.uncompressedBytes = totalUncompressed;
          const listing = files.slice(0, 80).map((e) => `${e.name} (${formatBytes(e.size)})`);
          text = `${introSentence(file, 'Archive')} Contains ${files.length} files, ${formatBytes(totalUncompressed)} uncompressed.` +
            (files.length ? `\n\nContents:\n${listing.join('\n')}${files.length > 80 ? `\n… ${files.length - 80} more entries.` : ''}` : '');
          textKind = 'converted';
        } catch {
          text = introSentence(file, 'Archive');
          warnings.push(`.${ext} archives cannot be listed in-browser without extraction support`);
        }
        break;
      }

      case 'binary':
      case 'unknown':
      default: {
        onProgress?.(0.3, 'Analyzing binary content');
        const cap = Math.min(file.size, 24 * 1024 * 1024);
        const buf = await file.slice(0, cap).arrayBuffer();
        const bytes = new Uint8Array(buf);
        const kind = guessBinaryKind(bytes, ext);
        const entropy = shannonEntropy(bytes);
        metadata.kind = kind.kind;
        metadata.entropy = +entropy.toFixed(2);
        const strings = extractStrings(bytes, { minLen: 6, maxStrings: 600 });
        const uniq = Array.from(new Set(strings));
        const interesting = uniq.filter((s) => !/^[a-zA-Z]?$/.test(s) && !/^[\W_]+$/.test(s)).slice(0, 300);
        text = [
          introSentence(file, 'Binary file'),
          `Type: ${kind.kind}. ${kind.detail}.`,
          entropy > 7.2
            ? 'Very high entropy: the content is compressed or encrypted, so no readable text can be extracted.'
            : `Extracted ${interesting.length} readable string${interesting.length === 1 ? '' : 's'}:`,
          entropy <= 7.2 && interesting.length ? interesting.join('\n') : '',
        ].filter(Boolean).join('\n\n');
        textKind = 'strings';
        if (file.size > cap) warnings.push(`Analyzed first ${formatBytes(cap)} of ${formatBytes(file.size)}`);
        break;
      }
    }
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : 'Ingestion step failed');
    text = text || introSentence(file, 'File');
  }

  onProgress?.(1, 'Done');
  return {
    fileName: file.name,
    sizeBytes: file.size,
    ext,
    category,
    text,
    textKind,
    metadata,
    preview: text.slice(0, 600),
    warnings,
    durationMs: performance.now() - t0,
    ocrSuggested,
  };
}

export async function ingestText(raw: string, hintName = 'pasted.txt'): Promise<IngestResult> {
  const t0 = performance.now();
  const text = cleanText(raw);
  return {
    fileName: hintName,
    sizeBytes: new Blob([raw]).size,
    ext: hintName.split('.').pop()?.toLowerCase() ?? 'txt',
    category: 'text',
    text,
    textKind: 'plain',
    metadata: { pasted: true, characters: text.length },
    preview: text.slice(0, 600),
    warnings: [],
    durationMs: performance.now() - t0,
  };
}

export type { ZipEntry };
