async function fetchNotes() {
  const res = await fetch('/api/notas/getAllByIdUser');
  const j = await res.json();
  if (!j.ok) { document.getElementById('notesList').innerHTML = '<p>No autenticado</p>'; return; }
  const list = j.notes;
  const container = document.getElementById('notesList');
  container.innerHTML = '';
  list.forEach(n => {
    const el = document.createElement('div');
    el.style = 'border:1px solid #ddd;padding:8px;margin-bottom:8px;border-radius:8px;';
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div><small>${new Date(n.created_at).toLocaleString()}</small></div>
        <div>
          <button data-id="${n.id}" class="editBtn">Editar</button>
          <button data-id="${n.id}" class="delBtn">Borrar</button>
        </div>
      </div>
      <div class="content" data-id="${n.id}" style="margin-top:8px;">${escapeHtml(n.content)}</div>
    `;
    container.appendChild(el);
  });
  attachHandlers();
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function attachHandlers() {
  document.querySelectorAll('.delBtn').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Borrar nota?')) return;
      const id = b.getAttribute('data-id');
      await fetch('/api/nota/borrar', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id }) });
      fetchNotes();
    };
  });
  document.querySelectorAll('.editBtn').forEach(b => {
    b.onclick = async () => {
      const id = b.getAttribute('data-id');
      const contentEl = document.querySelector('.content[data-id="'+id+'"]');
      const newContent = prompt('Editar nota', contentEl.textContent);
      if (newContent === null) return;
      await fetch('/api/nota/editar', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id, content: newContent }) });
      fetchNotes();
    };
  });
}

document.getElementById('createBtn').addEventListener('click', async () => {
  const content = document.getElementById('newContent').value.trim();
  if (!content) { alert('Escribe algo'); return; }
  await fetch('/api/nota/crear', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ content }) });
  document.getElementById('newContent').value = '';
  fetchNotes();
});

fetchNotes();
