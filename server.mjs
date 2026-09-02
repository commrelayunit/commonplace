import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { lookup } from 'node:dns/promises';

const root = process.cwd();
const dataDir = process.env.COMMONPLACE_DATA_DIR || join(root, 'data');
const dbPath = join(dataDir, 'commonplace.sqlite');
await mkdir(dataDir, { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');
db.exec(await readFile(join(root, 'db/schema.sql'), 'utf8'));

const legacyExamples = ['The Case for the Creative Reading List', 'Ways of Seeing a System', 'Designing for the Long Middle', 'A Field Guide to Taking Notes', 'The More-than-Human Interface', 'Building Things That Last'];
db.prepare(`DELETE FROM items WHERE title IN (${legacyExamples.map(() => '?').join(',')})`).run(...legacyExamples);

function item(row) { return { ...row, id: Number(row.id), progress: Number(row.progress ?? 0), tags: row.tags ? row.tags.split('||') : [] }; }
function listItems() { return db.prepare(`SELECT i.id,i.title,i.author,i.kind,i.source_url,i.body,i.file_name,i.file_mime,i.colour,COALESCE(p.percent,0) progress,COALESCE(GROUP_CONCAT(t.name,'||'),'') tags FROM items i LEFT JOIN reading_progress p ON p.item_id=i.id LEFT JOIN item_tags it ON it.item_id=i.id LEFT JOIN tags t ON t.id=it.tag_id GROUP BY i.id ORDER BY p.percent DESC, i.updated_at DESC`).all().map(item); }
function getItem(id) { const row = db.prepare(`SELECT i.id,i.title,i.author,i.kind,i.source_url,i.body,i.file_name,i.file_mime,i.colour,COALESCE(p.percent,0) progress,COALESCE(p.scroll_y,0) scroll_y,COALESCE(GROUP_CONCAT(t.name,'||'),'') tags FROM items i LEFT JOIN reading_progress p ON p.item_id=i.id LEFT JOIN item_tags it ON it.item_id=i.id LEFT JOIN tags t ON t.id=it.tag_id WHERE i.id=? GROUP BY i.id`).get(id); return row && item(row); }
function notes(id) { return db.prepare('SELECT id,body,created_at,updated_at FROM notes WHERE item_id=? ORDER BY updated_at DESC').all(id); }
function json(res, status, payload) { res.writeHead(status, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(payload)); }
async function body(req) { let value=''; for await (const chunk of req) value += chunk; return value ? JSON.parse(value) : {}; }
function withTags(itemId, tags=[]) { const addTag=db.prepare('INSERT OR IGNORE INTO tags(name) VALUES(?)'); const attach=db.prepare('INSERT OR IGNORE INTO item_tags(item_id,tag_id) SELECT ?,id FROM tags WHERE name=?'); for (const tag of tags.map(x=>x.trim().toLowerCase()).filter(Boolean)) { addTag.run(tag); attach.run(itemId,tag); } }
function type(path) { return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[extname(path)] || 'application/octet-stream'; }
function decodeHtml(value='') { return value.replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/\s+/g,' ').trim(); }
function fallbackUrlTitle(value) { const url=new URL(value); const leaf=decodeURIComponent(url.pathname.split('/').filter(Boolean).pop()||'').replace(/[-_]+/g,' ').replace(/\.[a-z0-9]{1,8}$/i,'').trim(); return leaf ? `${url.hostname} — ${leaf}` : url.hostname; }
function privateAddress(address) { return address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:') || /^127\./.test(address) || /^10\./.test(address) || /^192\.168\./.test(address) || /^169\.254\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address); }
async function safeRemoteUrl(value) { const url=new URL(value); if (!['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw Error('Use a normal public http(s) URL.'); if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) throw Error('Local addresses cannot be fetched.'); const addresses=await lookup(url.hostname,{all:true}); if (!addresses.length || addresses.some(entry=>privateAddress(entry.address))) throw Error('Private-network addresses cannot be fetched.'); return url; }
async function inferUrlTitle(value) { const fallback=fallbackUrlTitle(value); try { const url=await safeRemoteUrl(value); const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(3500),headers:{accept:'text/html,application/xhtml+xml'}}); if (!response.ok || !String(response.headers.get('content-type')||'').includes('text/html')) return fallback; const html=(await response.text()).slice(0,300000); const og=html.match(/<meta[^>]+(?:property|name)=["'](?:og:title|twitter:title)["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:title|twitter:title)["']/i); const title=og?.[1] || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]; return decodeHtml(title||'') || fallback;
  } catch (error) { if (error.message?.includes('cannot be fetched') || error.message?.includes('normal public')) throw error; return fallback; }
}
function inferPdfTitle(fileName='', data) { const fallback=(fileName||'Untitled PDF').replace(/\.pdf$/i,'').replace(/[-_]+/g,' ').trim() || 'Untitled PDF'; const text=Buffer.isBuffer(data)?data.toString('latin1',0,Math.min(data.length,1024*1024)):''; const literal=text.match(/\/Title\s*\(([^)]{1,300})\)/); const hex=text.match(/\/Title\s*<([0-9a-fA-F]{2,600})>/); let title=literal?.[1]; if (!title && hex) { try { title=Buffer.from(hex[1],'hex').toString('utf8'); } catch {} } return decodeHtml(title||'').replace(/\\([()\\])/g,'$1') || fallback; }

const server=createServer(async (req,res)=>{
  const url=new URL(req.url, `http://${req.headers.host}`); const path=url.pathname;
  try {
    if (path === '/api/items' && req.method === 'GET') return json(res,200,listItems());
    if (path === '/api/items' && req.method === 'POST') { const x=await body(req); const sourceUrl=x.sourceUrl?.trim(); const file=x.fileData ? Buffer.from(x.fileData,'base64') : null; const isPdf=Boolean(file) && (x.fileMime==='application/pdf' || /\.pdf$/i.test(x.fileName||'')); if (!sourceUrl && !isPdf) return json(res,400,{error:'Paste a URL or choose a PDF.'}); if (sourceUrl && file) return json(res,400,{error:'Add one thing at a time: a URL or a PDF.'}); const title=sourceUrl ? await inferUrlTitle(sourceUrl) : inferPdfTitle(x.fileName,file); const kind=isPdf?'pdf':'article'; const out=db.prepare('INSERT INTO items(title,author,kind,source_url,body,file_name,file_mime,file_data,colour) VALUES(?,?,?,?,?,?,?,?,?)').run(title,'',kind,sourceUrl||null,null,isPdf?(x.fileName||'reading.pdf'):null,isPdf?'application/pdf':null,file,'#3e725f'); db.prepare('INSERT INTO reading_progress(item_id) VALUES(?)').run(out.lastInsertRowid); withTags(out.lastInsertRowid,Array.isArray(x.tags)?x.tags:[]); return json(res,201,getItem(out.lastInsertRowid)); }
    const match=path.match(/^\/api\/items\/(\d+)(?:\/(.+))?$/); if(match) { const id=Number(match[1]), action=match[2]; if (!getItem(id)) return json(res,404,{error:'Not found'});
      if (!action && req.method==='GET') return json(res,200,{...getItem(id),notes:notes(id)});
      if (action==='progress' && req.method==='PUT') { const x=await body(req); db.prepare('INSERT INTO reading_progress(item_id,percent,scroll_y,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(item_id) DO UPDATE SET percent=excluded.percent,scroll_y=excluded.scroll_y,updated_at=CURRENT_TIMESTAMP').run(id,Math.max(0,Math.min(100,Number(x.percent)||0)),Math.max(0,Number(x.scrollY)||0)); return json(res,200,getItem(id)); }
      if (action==='notes' && req.method==='POST') { const x=await body(req); if(!x.body?.trim()) return json(res,400,{error:'A note cannot be empty.'}); const out=db.prepare('INSERT INTO notes(item_id,body) VALUES(?,?)').run(id,x.body.trim()); return json(res,201,db.prepare('SELECT id,body,created_at,updated_at FROM notes WHERE id=?').get(out.lastInsertRowid)); }
      if (action==='content' && req.method==='GET') { const row=db.prepare('SELECT file_data,file_mime,file_name FROM items WHERE id=?').get(id); if(!row.file_data) return json(res,404,{error:'No local file attached'}); res.writeHead(200,{'content-type':row.file_mime||'application/octet-stream','content-disposition':`inline; filename="${row.file_name||'reading'}`}); return res.end(row.file_data); }
    }
    if (req.method==='GET') { const staticPath = path==='/' || path.startsWith('/read/') ? join(root,'index.html') : join(root,path); const data=await readFile(staticPath); res.writeHead(200,{'content-type':type(staticPath)}); return res.end(data); }
    json(res,404,{error:'Not found'});
  } catch(error) { console.error(error); json(res,500,{error:'Something went wrong locally.'}); }
});
server.listen(process.env.PORT || 4173,()=>console.log(`Commonplace listening on http://localhost:${process.env.PORT||4173}`));
