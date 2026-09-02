import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const dbPath = join(root, 'data', 'commonplace.sqlite');
await mkdir(join(root, 'data'), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');
db.exec(await readFile(join(root, 'db/schema.sql'), 'utf8'));

const count = db.prepare('SELECT COUNT(*) AS count FROM items').get().count;
if (!count) seed();

function seed() {
  const add = db.prepare('INSERT INTO items(title,author,kind,body,source_url,colour) VALUES(?,?,?,?,?,?)');
  const progress = db.prepare('INSERT INTO reading_progress(item_id,percent,scroll_y) VALUES(?,?,?)');
  const addTag = db.prepare('INSERT OR IGNORE INTO tags(name) VALUES(?)');
  const attach = db.prepare('INSERT OR IGNORE INTO item_tags(item_id,tag_id) SELECT ?, id FROM tags WHERE name=?');
  const examples = [
    ['The Case for the Creative Reading List','Mara Lin','article','Reading lists are often designed as funnels: add, save, optimise, complete. This one wants to be a shelf instead. Things may wait. They may travel between rooms. They may gather a note or two at the edge.\n\nA good list does not turn attention into debt. It quietly keeps a door open for the thought that was not ready yesterday.','https://example.org/creative-reading-list','#e86343',62,'attention'],
    ['Ways of Seeing a System','A. S. Patel','article','Systems are rarely visible all at once. We notice them by returning, tracing a line, and letting a pattern become familiar enough to name.\n\nThe work is slow because it asks for a different form of attention: not collecting every signal, but staying with the useful ones.','https://example.org/ways-of-seeing','#506f93',38,'systems'],
    ['Designing for the Long Middle','J. Ibrahim','pdf',null,null,'#aa6e55',0,'design'],
    ['A Field Guide to Taking Notes','M. K. Hall','guide','A note does not need to be complete to be useful. It needs a place to return to, a small piece of context, and enough warmth that you will recognise why it mattered.',null,'#6e7d43',0,'notes'],
    ['The More-than-Human Interface','N. Ortiz','paper','Interfaces organise relationships. When they work well, they make room for the things that cannot be reduced to a click target or a metric.',null,'#624d7e',81,'interfaces'],
    ['Building Things That Last','Clare Vincent','course','A course is a path, not a backlog item. Keep the next lesson close and the rest of the syllabus out of your peripheral vision.',null,'#a77938',0,'craft']
  ];
  for (const [title, author, kind, body, url, colour, pct, tag] of examples) {
    const { lastInsertRowid } = add.run(title, author, kind, body, url, colour);
    progress.run(lastInsertRowid, pct, 0); addTag.run(tag); attach.run(lastInsertRowid, tag);
  }
}

function item(row) { return { ...row, id: Number(row.id), progress: Number(row.progress ?? 0), tags: row.tags ? row.tags.split('||') : [] }; }
function listItems() { return db.prepare(`SELECT i.id,i.title,i.author,i.kind,i.source_url,i.body,i.file_name,i.file_mime,i.colour,COALESCE(p.percent,0) progress,COALESCE(GROUP_CONCAT(t.name,'||'),'') tags FROM items i LEFT JOIN reading_progress p ON p.item_id=i.id LEFT JOIN item_tags it ON it.item_id=i.id LEFT JOIN tags t ON t.id=it.tag_id GROUP BY i.id ORDER BY p.percent DESC, i.updated_at DESC`).all().map(item); }
function getItem(id) { const row = db.prepare(`SELECT i.id,i.title,i.author,i.kind,i.source_url,i.body,i.file_name,i.file_mime,i.colour,COALESCE(p.percent,0) progress,COALESCE(p.scroll_y,0) scroll_y,COALESCE(GROUP_CONCAT(t.name,'||'),'') tags FROM items i LEFT JOIN reading_progress p ON p.item_id=i.id LEFT JOIN item_tags it ON it.item_id=i.id LEFT JOIN tags t ON t.id=it.tag_id WHERE i.id=? GROUP BY i.id`).get(id); return row && item(row); }
function notes(id) { return db.prepare('SELECT id,body,created_at,updated_at FROM notes WHERE item_id=? ORDER BY updated_at DESC').all(id); }
function json(res, status, payload) { res.writeHead(status, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(payload)); }
async function body(req) { let value=''; for await (const chunk of req) value += chunk; return value ? JSON.parse(value) : {}; }
function withTags(itemId, tags=[]) { const addTag=db.prepare('INSERT OR IGNORE INTO tags(name) VALUES(?)'); const attach=db.prepare('INSERT OR IGNORE INTO item_tags(item_id,tag_id) SELECT ?,id FROM tags WHERE name=?'); for (const tag of tags.map(x=>x.trim().toLowerCase()).filter(Boolean)) { addTag.run(tag); attach.run(itemId,tag); } }
function type(path) { return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[extname(path)] || 'application/octet-stream'; }

const server=createServer(async (req,res)=>{
  const url=new URL(req.url, `http://${req.headers.host}`); const path=url.pathname;
  try {
    if (path === '/api/items' && req.method === 'GET') return json(res,200,listItems());
    if (path === '/api/items' && req.method === 'POST') { const x=await body(req); if(!x.title?.trim()) return json(res,400,{error:'A title is required.'}); const kind=['article','pdf','text','guide','course','paper'].includes(x.kind)?x.kind:'article'; const file=x.fileData ? Buffer.from(x.fileData,'base64') : null; const out=db.prepare('INSERT INTO items(title,author,kind,source_url,body,file_name,file_mime,file_data,colour) VALUES(?,?,?,?,?,?,?,?,?)').run(x.title.trim(),x.author?.trim()||'',kind,x.sourceUrl?.trim()||null,x.body?.trim()||null,x.fileName||null,x.fileMime||null,file,x.colour||'#3e725f'); db.prepare('INSERT INTO reading_progress(item_id) VALUES(?)').run(out.lastInsertRowid); withTags(out.lastInsertRowid,x.tags); return json(res,201,getItem(out.lastInsertRowid)); }
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
