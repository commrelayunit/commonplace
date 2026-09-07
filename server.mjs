import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { extname, join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { lookup } from 'node:dns/promises';
import 'dotenv/config';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const dataDir = process.env.COMMONPLACE_DATA_DIR || join(root, 'data');
const libraryDir = join(dataDir, 'library');
const dbPath = join(dataDir, 'commonplace.sqlite');
const config = {
  captureTimeoutMs: boundedInteger(process.env.CAPTURE_TIMEOUT_MS, 8_000, 1_000, 30_000),
  captureMaxBytes: boundedInteger(process.env.CAPTURE_MAX_BYTES, 8_000_000, 100_000, 30_000_000),
  uploadMaxBytes: boundedInteger(process.env.UPLOAD_MAX_BYTES, 25_000_000, 100_000, 30_000_000),
  firecrawlBaseUrl: optionalUrl(process.env.FIRECRAWL_BASE_URL),
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY || '',
  browserFallback: process.env.CAPTURE_BROWSER_FALLBACK === 'true',
  playwrightExecutable: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined
};
await mkdir(libraryDir, { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');
db.exec(await readFile(join(root, 'db/schema.sql'), 'utf8'));
for (const sql of [
  'ALTER TABLE items ADD COLUMN artifact_dir TEXT',
  'ALTER TABLE items ADD COLUMN content_path TEXT',
  'ALTER TABLE items ADD COLUMN original_path TEXT',
  'ALTER TABLE items ADD COLUMN capture_status TEXT NOT NULL DEFAULT \'legacy\'',
  'ALTER TABLE items ADD COLUMN parser_name TEXT',
  'ALTER TABLE items ADD COLUMN parser_version TEXT',
  'ALTER TABLE items ADD COLUMN source_fetched_at TEXT',
  'ALTER TABLE items ADD COLUMN source_content_type TEXT'
]) { try { db.exec(sql); } catch (error) { if (!/duplicate column/i.test(error.message)) throw error; } }

const legacyExamples = ['The Case for the Creative Reading List', 'Ways of Seeing a System', 'Designing for the Long Middle', 'A Field Guide to Taking Notes', 'The More-than-Human Interface', 'Building Things That Last'];
db.prepare(`DELETE FROM items WHERE title IN (${legacyExamples.map(() => '?').join(',')})`).run(...legacyExamples);

function item(row) { return { ...row, id: Number(row.id), progress: Number(row.progress ?? 0), tags: row.tags ? row.tags.split('||') : [] }; }
const select = `i.id,i.title,i.author,i.kind,i.source_url,i.body,i.file_name,i.file_mime,i.colour,i.artifact_dir,i.content_path,i.original_path,i.capture_status,i.parser_name,i.source_fetched_at,COALESCE(p.percent,0) progress,COALESCE(p.scroll_y,0) scroll_y,COALESCE(GROUP_CONCAT(t.name,'||'),'') tags`;
function listItems() { return db.prepare(`SELECT ${select} FROM items i LEFT JOIN reading_progress p ON p.item_id=i.id LEFT JOIN item_tags it ON it.item_id=i.id LEFT JOIN tags t ON t.id=it.tag_id GROUP BY i.id ORDER BY i.updated_at DESC`).all().map(item); }
function getItem(id) { const row = db.prepare(`SELECT ${select} FROM items i LEFT JOIN reading_progress p ON p.item_id=i.id LEFT JOIN item_tags it ON it.item_id=i.id LEFT JOIN tags t ON t.id=it.tag_id WHERE i.id=? GROUP BY i.id`).get(id); return row && item(row); }
function notes(id) { return db.prepare('SELECT id,body,created_at,updated_at FROM notes WHERE item_id=? ORDER BY updated_at DESC').all(id); }
function json(res, status, payload) { res.writeHead(status, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(payload)); }
async function body(req) { let value=''; for await (const chunk of req) { value += chunk; if (Buffer.byteLength(value) > config.uploadMaxBytes) throw Error('Upload is too large.'); } return value ? JSON.parse(value) : {}; }
function withTags(itemId, tags=[]) { const addTag=db.prepare('INSERT OR IGNORE INTO tags(name) VALUES(?)'); const attach=db.prepare('INSERT OR IGNORE INTO item_tags(item_id,tag_id) SELECT ?,id FROM tags WHERE name=?'); for (const tag of tags.map(x=>x.trim().toLowerCase()).filter(Boolean)) { addTag.run(tag); attach.run(itemId,tag); } }
function type(path) { return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[extname(path)] || 'application/octet-stream'; }
function decodeHtml(value='') { return value.replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/\s+/g,' ').trim(); }
function fallbackUrlTitle(value) { const url=new URL(value); const leaf=decodeURIComponent(url.pathname.split('/').filter(Boolean).pop()||'').replace(/[-_]+/g,' ').replace(/\.[a-z0-9]{1,8}$/i,'').trim(); return leaf ? `${url.hostname} — ${leaf}` : url.hostname; }
function boundedInteger(value, fallback, min, max) { const number = Number(value); return Number.isInteger(number) && number >= min && number <= max ? number : fallback; }
function optionalUrl(value) { if (!value) return null; try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url : null; } catch { return null; } }
function privateAddress(address) { return address === '::1' || address === '0.0.0.0' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:') || /^127\./.test(address) || /^10\./.test(address) || /^192\.168\./.test(address) || /^169\.254\./.test(address) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address); }
async function safeRemoteUrl(value) { const url=new URL(value); if (!['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw Error('Use a normal public http(s) URL.'); if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) throw Error('Local addresses cannot be captured.'); const addresses=await lookup(url.hostname,{all:true}); if (!addresses.length || addresses.some(entry=>privateAddress(entry.address))) throw Error('Private-network addresses cannot be captured.'); return url; }
async function boundedFetch(url, accept) { const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(config.captureTimeoutMs),headers:{accept}}); if (!response.ok) throw Error(`Source returned ${response.status}.`); const length=Number(response.headers.get('content-length')||0); if (length > config.captureMaxBytes) throw Error('Source is too large to capture.'); const data=Buffer.from(await response.arrayBuffer()); if (data.length > config.captureMaxBytes) throw Error('Source is too large to capture.'); return {response,data}; }
function stripHtml(html) { return decodeHtml(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi,'').replace(/<\/(?:p|div|h[1-6]|li|article|section)>/gi,'\n\n').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,' ')); }
function htmlToMarkdown(html, pageUrl, fallbackTitle) { const document = new JSDOM(html, { url: pageUrl }).window.document; const article = new Readability(document).parse(); const title = article?.title?.trim() || inferHtmlTitle(html, fallbackTitle); const text = article?.textContent?.trim() || stripHtml(html); return { title, markdown: `# ${title}\n\n_Source: ${pageUrl}_\n\n${text}\n` }; }
function inferHtmlTitle(html, fallback) { const og=html.match(/<meta[^>]+(?:property|name)=["'](?:og:title|twitter:title)["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:title|twitter:title)["']/i); return decodeHtml(og?.[1] || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '') || fallback; }
function inferPdfTitle(fileName='', data) { const fallback=(fileName||'Untitled PDF').replace(/\.pdf$/i,'').replace(/[-_]+/g,' ').trim() || 'Untitled PDF'; const text=Buffer.isBuffer(data)?data.toString('latin1',0,Math.min(data.length,1024*1024)):''; const literal=text.match(/\/Title\s*\(([^)]{1,300})\)/); return decodeHtml(literal?.[1]||'').replace(/\\([()\\])/g,'$1') || fallback; }
async function pdfToMarkdown(data, title) {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
    const pages = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const content = await (await document.getPage(number)).getTextContent();
      const text = content.items.map(item => item.str).filter(Boolean).join(' ').trim();
      if (text) pages.push(`## Page ${number}\n\n${text}`);
    }
    if (pages.length) return `# ${title}\n\n${pages.join('\n\n')}`;
  } catch (error) { console.warn(`PDF.js text extraction failed: ${error.message}`); }
  const latin=data.toString('latin1'); const chunks=[...latin.matchAll(/\(([^()]{2,500})\)\s*Tj/g)].map(m=>m[1].replace(/\\([()\\])/g,'$1')).filter(s=>/[A-Za-z]{3}/.test(s)); const plain=chunks.join('\n\n') || 'The PDF was preserved locally. Its text layer could not be read by the lightweight converter.'; return `# ${title}\n\n${plain}\n`;
}
async function itemDir(id) { const dir=join(libraryDir,String(id)); await mkdir(join(dir,'assets'),{recursive:true}); return dir; }
async function firecrawlCapture(sourceUrl) {
  if (!config.firecrawlBaseUrl) return null;
  const endpoint = new URL('/v1/scrape', config.firecrawlBaseUrl);
  const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(config.captureTimeoutMs), headers: { 'content-type': 'application/json', ...(config.firecrawlApiKey ? { authorization: `Bearer ${config.firecrawlApiKey}` } : {}) }, body: JSON.stringify({ url: sourceUrl, formats: ['markdown', 'html'], onlyMainContent: true }) });
  if (!response.ok) throw Error(`Firecrawl returned ${response.status}.`);
  const result = await response.json(); const data = result.data || result;
  if (typeof data.markdown !== 'string' || !data.markdown.trim()) throw Error('Firecrawl returned no Markdown.');
  if (Buffer.byteLength(data.markdown) > config.captureMaxBytes) throw Error('Firecrawl content is too large to capture.');
  return { title: data.metadata?.title || fallbackUrlTitle(sourceUrl), markdown: data.markdown, html: typeof data.html === 'string' ? data.html : null, contentType: 'text/markdown' };
}
async function browserHtml(url) {
  if (!config.browserFallback) return null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: config.playwrightExecutable });
  try { const page = await browser.newPage(); await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: config.captureTimeoutMs }); return await page.content(); }
  finally { await browser.close(); }
}
async function captureUrl(sourceUrl, id) {
  const url=await safeRemoteUrl(sourceUrl); let captured;
  if (config.firecrawlBaseUrl) { try { captured = await firecrawlCapture(url.href); } catch (error) { console.warn(`Self-hosted Firecrawl unavailable: ${error.message}`); } }
  if (!captured) {
    let html; try { const {response,data}=await boundedFetch(url,'text/html,application/xhtml+xml'); if (!(response.headers.get('content-type')||'').includes('text/html')) throw Error('The URL did not return an HTML page.'); html=data.toString('utf8'); }
    catch (error) { html = await browserHtml(url); if (!html) throw error; }
    const local = htmlToMarkdown(html,url.href,fallbackUrlTitle(sourceUrl)); captured={title:local.title,markdown:local.markdown,html,contentType:'text/html',parser:'readability'};
  }
  const dir=await itemDir(id); const originalPath=join(dir, captured.html ? 'source.html' : 'source-url.txt');
  await writeFile(originalPath, captured.html || `${url.href}\n`); const contentPath=join(dir,'content.md'); await writeFile(contentPath,captured.markdown);
  return {title:captured.title,dir,contentPath,originalPath,markdown:captured.markdown,parser:captured.parser || 'self-hosted-firecrawl',contentType:captured.contentType,originalMime:captured.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8'};
}
async function capturePdf(fileName, data, id) { const title=inferPdfTitle(fileName,data); const dir=await itemDir(id); const original=join(dir,'original.pdf'); const contentPath=join(dir,'content.md'); await writeFile(original,data); const markdown=await pdfToMarkdown(data,title); await writeFile(contentPath,markdown); return {title,dir,contentPath,originalPath:original,markdown,parser:'pdfjs-text-layer',contentType:'application/pdf',originalMime:'application/pdf'}; }

const server=createServer(async (req,res)=>{
  const url=new URL(req.url, `http://${req.headers.host}`); const path=url.pathname;
  try {
    if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (path === '/api/items' && req.method === 'GET') return json(res,200,listItems());
    if (path === '/api/items' && req.method === 'POST') {
      const x=await body(req); const sourceUrl=x.sourceUrl?.trim(); const file=x.fileData ? Buffer.from(x.fileData,'base64') : null; const isPdf=Boolean(file) && (x.fileMime==='application/pdf' || /\.pdf$/i.test(x.fileName||''));
      if (!sourceUrl && !isPdf) return json(res,400,{error:'Paste a URL or choose a PDF.'}); if (sourceUrl && file) return json(res,400,{error:'Add one thing at a time: a URL or a PDF.'});
      const kind=isPdf?'pdf':'article'; const out=db.prepare('INSERT INTO items(title,author,kind,source_url,file_name,file_mime,file_data,colour,capture_status) VALUES(?,?,?,?,?,?,?,?,?)').run('Capturing…','',kind,sourceUrl||null,isPdf?(x.fileName||'reading.pdf'):null,isPdf?'application/pdf':null,file,'#6d625c','capturing'); const id=Number(out.lastInsertRowid);
      let captured;
      try { captured=sourceUrl ? await captureUrl(sourceUrl,id) : await capturePdf(x.fileName,file,id); }
      catch (error) { db.prepare('DELETE FROM items WHERE id=?').run(id); await rm(join(libraryDir, String(id)), { recursive: true, force: true }); throw error; }
      db.prepare('UPDATE items SET title=?,body=?,file_mime=COALESCE(file_mime,?),artifact_dir=?,content_path=?,original_path=?,capture_status=?,parser_name=?,parser_version=?,source_fetched_at=CURRENT_TIMESTAMP,source_content_type=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(captured.title,captured.markdown,captured.originalMime,captured.dir,captured.contentPath,captured.originalPath,'ready',captured.parser,'1',captured.contentType,id);
      db.prepare('INSERT INTO reading_progress(item_id) VALUES(?)').run(id); withTags(id,Array.isArray(x.tags)?x.tags:[]); return json(res,201,getItem(id));
    }
    const match=path.match(/^\/api\/items\/(\d+)(?:\/(.+))?$/); if(match) { const id=Number(match[1]), action=match[2]; if (!getItem(id)) return json(res,404,{error:'Not found'});
      if (!action && req.method==='GET') return json(res,200,{...getItem(id),notes:notes(id)});
      if (action==='progress' && req.method==='PUT') { const x=await body(req); db.prepare('INSERT INTO reading_progress(item_id,percent,scroll_y,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(item_id) DO UPDATE SET percent=excluded.percent,scroll_y=excluded.scroll_y,updated_at=CURRENT_TIMESTAMP').run(id,Math.max(0,Math.min(100,Number(x.percent)||0)),Math.max(0,Number(x.scrollY)||0)); return json(res,200,getItem(id)); }
      if (action==='notes' && req.method==='POST') { const x=await body(req); if(!x.body?.trim()) return json(res,400,{error:'A note cannot be empty.'}); const out=db.prepare('INSERT INTO notes(item_id,body) VALUES(?,?)').run(id,x.body.trim()); return json(res,201,db.prepare('SELECT id,body,created_at,updated_at FROM notes WHERE id=?').get(out.lastInsertRowid)); }
      if (action==='original' && req.method==='GET') { const row=db.prepare('SELECT original_path,file_mime,file_name FROM items WHERE id=?').get(id); if(!row.original_path) return json(res,404,{error:'No original attached'}); const data=await readFile(row.original_path); res.writeHead(200,{'content-type':row.file_mime||'application/octet-stream','content-disposition':`inline; filename="${row.file_name||basename(row.original_path)}"`}); return res.end(data); }
    }
    if (req.method==='GET') { const staticPath = path==='/' || path.startsWith('/read/') ? join(root,'index.html') : join(root,path); const data=await readFile(staticPath); res.writeHead(200,{'content-type':type(staticPath)}); return res.end(data); }
    json(res,404,{error:'Not found'});
  } catch(error) { console.error(error); json(res,400,{error:error.message||'Something went wrong locally.'}); }
});
server.listen(process.env.PORT || 4173,()=>console.log(`Commonplace listening on http://localhost:${process.env.PORT||4173}`));
