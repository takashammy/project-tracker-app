const DB_NAME = "ProjectTracker";
const STORE = "projects";
let db;
let projects = [];

const columns = ["backlog", "active", "paused", "done"];
const columnLabels = { backlog: "Backlog", active: "Active", paused: "Paused", done: "Done" };

// IndexedDB
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => { db = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}

function saveProject(p) {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(p);
    tx.oncomplete = resolve;
  });
}

function loadAll() {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
  });
}

// Render
function render() {
  const board = document.getElementById("board");
  board.innerHTML = "";
  columns.forEach(col => {
    const div = document.createElement("div");
    div.className = "column";
    div.innerHTML = `<h2>${columnLabels[col]}</h2>`;
    projects.filter(p => p.status === col).forEach(p => {
      const card = document.createElement("div");
      card.className = `card ${col}`;
      card.innerHTML = `
        <h3>${escape(p.title)}</h3>
        <div class="meta">${p.nextAction ? escape(p.nextAction) : "No next action"}</div>
      `;
      card.onclick = () => openDetail(p);
      div.appendChild(card);
    });
    board.appendChild(div);
  });
}

function escape(s) { return (s || "").replace(/</g, "<").replace(/>/g, ">"); }

// Detail modal
function openDetail(p) {
  const modal = document.getElementById("modal");
  const body = document.getElementById("modalBody");
  body.innerHTML = `
    <h2>${escape(p.title)}</h2>
    <label>Status</label>
    <select id="dStatus">
      ${columns.map(c => `<option value="${c}" ${p.status===c?"selected":""}>${columnLabels[c]}</option>`).join("")}
    </select>
    <label>Next action</label>
    <input id="dNext" value="${escape(p.nextAction || "")}" />
    <label>Notes</label>
    <textarea id="dNotes">${escape(p.notes || "")}</textarea>
    <label>Links (one per line)</label>
    <textarea id="dLinks">${escape((p.links || []).join("\n"))}</textarea>
    <div style="margin-top:1rem; display:flex; gap:0.5rem;">
      <button id="saveDetail">Save</button>
      <button id="exportMd">Export MD</button>
      <button id="deleteBtn" style="margin-left:auto; color:#dc2626;">Delete</button>
    </div>
  `;
  modal.classList.remove("hidden");

  document.getElementById("saveDetail").onclick = async () => {
    p.status = document.getElementById("dStatus").value;
    p.nextAction = document.getElementById("dNext").value;
    p.notes = document.getElementById("dNotes").value;
    p.links = document.getElementById("dLinks").value.split("\n").map(s => s.trim()).filter(Boolean);
    p.updated = new Date().toISOString();
    await saveProject(p);
    projects = await loadAll();
    render();
    modal.classList.add("hidden");
  };

  document.getElementById("exportMd").onclick = () => {
    const md = `# ${p.title}\n\n**Status:** ${p.status}\n**Next:** ${p.nextAction || "-"}\n\n## Notes\n${p.notes || ""}\n\n## Links\n${(p.links||[]).map(l => `- ${l}`).join("\n")}`;
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${p.title.replace(/\s+/g, "-")}.md`;
    a.click();
  };

  document.getElementById("deleteBtn").onclick = async () => {
    if (confirm("Delete this project?")) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(p.id);
      tx.oncomplete = async () => {
        projects = await loadAll();
        render();
        modal.classList.add("hidden");
      };
    }
  };
}

// Add new
document.getElementById("addBtn").onclick = () => {
  const title = prompt("Project title?");
  if (!title) return;
  const p = {
    id: crypto.randomUUID(),
    title,
    status: "backlog",
    nextAction: "",
    notes: "",
    links: [],
    created: new Date().toISOString(),
    updated: new Date().toISOString()
  };
  saveProject(p).then(async () => {
    projects = await loadAll();
    render();
  });
};

// Settings
const settingsModal = document.getElementById("settingsModal");
document.getElementById("settingsBtn").onclick = () => settingsModal.classList.remove("hidden");
document.querySelectorAll(".close").forEach(b => b.onclick = () => {
  document.querySelectorAll(".modal").forEach(m => m.classList.add("hidden"));
});

document.getElementById("saveSettings").onclick = () => {
  localStorage.setItem("ghToken", document.getElementById("tokenInput").value);
  localStorage.setItem("ghRepo", document.getElementById("repoInput").value);
  localStorage.setItem("ghPath", document.getElementById("pathInput").value);
  settingsModal.classList.add("hidden");
  alert("Saved. Refresh or hit Sync to pull.");
};

// Load saved settings
document.getElementById("tokenInput").value = localStorage.getItem("ghToken") || "";
document.getElementById("repoInput").value = localStorage.getItem("ghRepo") || "takashammy/project-tracker";
document.getElementById("pathInput").value = localStorage.getItem("ghPath") || "projects.json";

// GitHub sync
async function pullFromGitHub() {
  const token = localStorage.getItem("ghToken");
  const repo = localStorage.getItem("ghRepo") || "takashammy/project-tracker";
  const path = localStorage.getItem("ghPath") || "projects.json";
  if (!token) return false;

  try {
    const [owner, name] = repo.split("/");
    const res = await fetch(`https://api.github.com/repos/${owner}/${name}/contents/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw" }
    });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    if (Array.isArray(data)) {
      // merge by id
      const existing = new Map(projects.map(p => [p.id, p]));
      data.forEach(remote => {
        const local = existing.get(remote.id);
        if (!local || new Date(remote.updated) > new Date(local.updated || 0)) {
          existing.set(remote.id, remote);
        }
      });
      projects = Array.from(existing.values());
      // save all
      for (const p of projects) await saveProject(p);
      render();
      return true;
    }
  } catch (e) {
    console.warn("GitHub pull failed", e);
  }
  return false;
}

document.getElementById("syncBtn").onclick = async () => {
  const ok = await pullFromGitHub();
  alert(ok ? "Synced" : "Sync failed or no token");
};

// Init
async function init() {
  await openDB();
  projects = await loadAll();
  render();
  // auto pull on open
  pullFromGitHub();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js");
  }
}
init();