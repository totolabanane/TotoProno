const API_BASE = '/api';

function getToken(){ return localStorage.getItem('apex_token'); }
function getUser(){ try{ return JSON.parse(localStorage.getItem('apex_user')); }catch(e){ return null; } }
function setSession(token, user){
  localStorage.setItem('apex_token', token);
  localStorage.setItem('apex_user', JSON.stringify(user));
}
function clearSession(){
  localStorage.removeItem('apex_token');
  localStorage.removeItem('apex_user');
}

async function apiFetch(path, options = {}){
  const token = getToken();
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if(token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(API_BASE + path, Object.assign({}, options, { headers }));
  const data = await res.json().catch(() => ({}));
  if(!res.ok) throw new Error(data.error || 'Erreur serveur.');
  return data;
}

// Affiche l'état de connexion dans la nav sur TOUTES les pages.
// La déconnexion se fait uniquement depuis la page "Mon compte".
function reflectNavStatus(){
  const el = document.getElementById('navStatus');
  const cta = document.getElementById('navCta');
  if(!el) return;
  const user = getUser();
  if(user){
    el.innerHTML = `${user.name} · <span class="mono">${user.tier}</span>`;
    if(cta){ cta.textContent = 'Mon compte'; cta.href = 'compte.html'; }
  } else {
    el.innerHTML = '';
  }
}

document.addEventListener('DOMContentLoaded', reflectNavStatus);
