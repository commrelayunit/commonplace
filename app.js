const items = [
  {title:'The Case for the Creative Reading List', author:'Mara Lin', type:'essay', progress:62, colour:'#e86343', tag:'attention'},
  {title:'Ways of Seeing a System', author:'A. S. Patel', type:'article', progress:38, colour:'#506f93', tag:'systems'},
  {title:'Designing for the Long Middle', author:'J. Ibrahim', type:'pdf', progress:0, colour:'#aa6e55', tag:'design'},
  {title:'A Field Guide to Taking Notes', author:'M. K. Hall', type:'guide', progress:0, colour:'#6e7d43', tag:'notes'},
  {title:'The More-than-Human Interface', author:'N. Ortiz', type:'paper', progress:81, colour:'#624d7e', tag:'interfaces'},
  {title:'Building Things That Last', author:'Clare Vincent', type:'course', progress:0, colour:'#a77938', tag:'craft'}
];
const cards=document.querySelector('#cards'), reader=document.querySelector('#reader'), adder=document.querySelector('#adder');
const persisted=JSON.parse(localStorage.getItem('commonplace-items')||'[]'); items.push(...persisted);
function card(item,index){const progress=item.progress?`<i><b style="width:${item.progress}%"></b></i>${item.progress}%`:'for later';return `<article class="card" data-index="${index}" data-status="${item.progress?'reading':'saved'}"><div class="cover" style="background:${item.colour}"><span>${item.type}</span><small>cp. ${String(index+1).padStart(2,'0')}</small></div><div><h3>${item.title}</h3><p>${item.author}</p></div><div class="card-bottom"><span>${progress}</span><span>${item.tag||'untagged'} ↗</span></div></article>`}
function render(filter='all'){cards.innerHTML=items.filter(x=>filter==='all'||(filter==='reading'?x.progress:x.progress===0)).map((item)=>card(item,items.indexOf(item))).join('');document.querySelectorAll('.card').forEach(el=>el.addEventListener('click',()=>openReader(items[el.dataset.index])))}
function openReader(item){document.querySelector('#readerTitle').textContent=item.title;document.querySelector('#articleTitle').textContent=item.title;document.querySelector('#readerMeta').textContent=`${item.author} · ${item.type}`;document.querySelector('#readerProgress').style.width=`${item.progress||0}%`;document.querySelector('#readerPercent').textContent=item.progress?`${item.progress}%`:'not started';document.querySelector('#readerTags').innerHTML=`<span>${item.tag||'untagged'}</span><span>private shelf</span>`;reader.showModal()}
render();
document.querySelectorAll('.filter').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.filter').forEach(x=>x.classList.remove('selected'));button.classList.add('selected');render(button.dataset.filter)}));
document.querySelectorAll('.close').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
document.querySelectorAll('[data-open]').forEach(button=>button.addEventListener('click',()=>openReader(items[0])));
document.querySelector('#openAdd').onclick=()=>adder.showModal();
document.querySelector('#addForm').addEventListener('submit',event=>{event.preventDefault();const data=new FormData(event.target),title=data.get('title');const fresh={title,author:'saved just now',type:data.get('type'),tag:data.get('tag')||'unsorted',progress:0,colour:'#3e725f'};items.push(fresh);localStorage.setItem('commonplace-items',JSON.stringify(items.slice(6)));adder.close();render();event.target.reset()});
document.querySelector('#saveNote').onclick=()=>{localStorage.setItem('commonplace-note',document.querySelector('#noteInput').value);document.querySelector('#saveState').textContent='kept locally';};document.querySelector('#noteInput').value=localStorage.getItem('commonplace-note')||'';
document.querySelector('#viewNotes').onclick=()=>{document.querySelector('#noteInput').focus();reader.showModal()};
