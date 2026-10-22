import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowRight, Check, CheckCheck, ChevronDown, Circle, ClipboardList, Cloud,
  Edit3, ListTodo, LogIn, LogOut, Moon, Plus, Search, Settings, ShieldCheck,
  Sparkles, Sun, Trash2, UserRound, X,
} from "lucide-react";
import type { Session, Theme, Todo, User } from "../shared/types";
import { ApiError, request } from "./api";

type Filter = "all" | "active" | "completed";
type Panel = "profile" | "settings" | null;

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function storedTheme(): Theme {
  try {
    const value = localStorage.getItem("pocket.theme");
    if (value === "dark" || value === "light") return value;
  } catch (error) {
    console.warn("Browser theme preference could not be read.", error);
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function Modal({ title, children, close, error }: { title: string; children: ReactNode; close: () => void; error?: string | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className="modal" aria-labelledby={headingId} onCancel={close} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="modal-heading">
        <h2 id={headingId}>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={close}><X /></button>
      </div>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {children}
    </dialog>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [editing, setEditing] = useState<Todo | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const menuRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLButtonElement>(null);
  const user = session?.user;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("pocket.theme", theme); }
    catch (storageError) { console.warn("Browser theme preference could not be saved.", storageError); }
  }, [theme]);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const current = await request<Session>("/api/session");
        if (!mounted) return;
        setSession(current);
        if (current.user) {
          setTheme(current.user.theme);
          const tasks = await request<Todo[]>("/api/todos");
          if (mounted) setTodos(tasks);
        }
        const authError = new URLSearchParams(window.location.search).get("authError");
        if (mounted && authError) {
          setError(authError === "signin_cancelled" ? "Sign-in was cancelled. You can try again."
            : authError === "invalid_state" ? "Your sign-in request expired or could not be verified. Please try again."
            : "Microsoft sign-in failed. Please try again or check the app's Entra configuration.");
          window.history.replaceState({}, "", "/");
        }
      } catch (loadError) {
        if (mounted) setError(loadError instanceof Error ? loadError.message : "Could not connect to the server.");
      } finally { if (mounted) setLoading(false); }
    }
    void load();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMenuOpen(false); avatarRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  async function mutate(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (mutationError) {
      if (mutationError instanceof ApiError && mutationError.status === 401) {
        setSession((current) => current ? { ...current, user: null } : current);
        setTodos([]);
        setPanel(null);
        setEditing(null);
      }
      setError(mutationError instanceof Error ? mutationError.message : "Could not save your changes.");
    } finally { setBusy(false); }
  }

  function addTodo(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    void mutate(async () => {
      const todo = await request<Todo>("/api/todos", { method: "POST", body: JSON.stringify({ title: title.trim() }) }, session?.csrfToken);
      setTodos((current) => [todo, ...current]);
      setTitle("");
      setFilter("all");
      setSearch("");
    });
  }

  function updateTodo(todo: Todo, patch: Partial<Pick<Todo, "title" | "completed">>) {
    return mutate(async () => {
      const updated = await request<Todo>(`/api/todos/${todo.id}`, { method: "PATCH", body: JSON.stringify(patch) }, session?.csrfToken);
      setTodos((current) => current.map((item) => item.id === updated.id ? updated : item));
      setEditing(null);
    });
  }

  function deleteTodo(todo: Todo) {
    void mutate(async () => {
      await request<void>(`/api/todos/${todo.id}`, { method: "DELETE" }, session?.csrfToken);
      setTodos((current) => current.filter((item) => item.id !== todo.id));
    });
  }

  function changeTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    void mutate(async () => {
      const updated = await request<User>("/api/profile", { method: "PATCH", body: JSON.stringify({ theme: next }) }, session?.csrfToken);
      setSession((current) => current ? { ...current, user: updated } : current);
      setTheme(next);
    });
  }

  function logout() {
    setMenuOpen(false);
    void mutate(async () => {
      const result = await request<{ redirectUrl: string }>("/auth/logout", { method: "POST" }, session?.csrfToken);
      setSession(null);
      setTodos([]);
      window.location.assign(result.redirectUrl);
    });
  }

  const completed = todos.filter((todo) => todo.completed).length;
  const active = todos.length - completed;
  const visible = todos.filter((todo) =>
    (filter === "all" || (filter === "completed" ? todo.completed : !todo.completed)) &&
    todo.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const date = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Pocket Tasks home"><span className="brand-mark"><CheckCheck /></span>Pocket<span className="brand-light">Tasks</span></a>
        <div className="header-right">
          <span className="environment"><span className="status-dot" />Container Apps demo</span>
          <div className="account" ref={menuRef}>
            <button ref={avatarRef} className={`account-button ${user ? "signed-in" : ""}`} aria-label={user ? `Account: ${user.name}` : "Account: signed out"}
              aria-expanded={menuOpen} aria-controls="account-dropdown" disabled={loading || busy} onClick={() => setMenuOpen(!menuOpen)}>
              <span className="avatar">{user ? initials(user.name) : <UserRound />}</span><ChevronDown className="chevron" />
            </button>
            {menuOpen && <div className="account-dropdown" id="account-dropdown">
              {user ? <>
                <div className="account-summary"><strong>{user.name}</strong><span>{user.email || "Microsoft account"}</span><small><span className="status-dot" />Signed in with Microsoft</small></div>
                <button onClick={() => { setPanel("profile"); setMenuOpen(false); }}><UserRound />Profile</button>
                <button onClick={() => { setPanel("settings"); setMenuOpen(false); }}><Settings />Settings</button>
                <div className="menu-divider" />
                <button className="logout-button" onClick={logout}><LogOut />Log out</button>
              </> : <>
                <div className="account-summary"><strong>Welcome to Pocket Tasks</strong><span>Sign in to your own little workspace.</span></div>
                <a href="/auth/login"><LogIn />Sign in with Microsoft</a>
              </>}
            </div>}
          </div>
        </div>
      </header>

      <main>
        <section className="intro">
          <div><p className="eyebrow"><span className="tiny-line" />YOUR DAY, A LITTLE LIGHTER</p>
            <h1>{user ? `Hello, ${user.name.split(" ")[0]}.` : "Small tasks. Clear mind."}</h1>
            <p className="intro-copy">{user ? "A little focus goes a long way. Let's make today a good one." : "A little space to organize your day and focus on what matters."}</p>
          </div>
          <div className="date"><Sun /><span>{date}</span></div>
        </section>

        {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError(null)} aria-label="Dismiss error"><X /></button></div>}

        {loading ? <div className="loading-state" role="status"><span className="spinner" />Opening your workspace...</div> : !session ?
          <section className="welcome-card"><Cloud /><h2>We couldn't open your workspace</h2><p>Check the error above and reload to reconnect.</p><button className="primary-button" onClick={() => window.location.reload()}>Reload workspace<ArrowRight /></button></section>
          : !user ? <>
            <section className="welcome-card">
              <div className="welcome-art" aria-hidden="true"><span className="art-orbit orbit-one" /><span className="art-orbit orbit-two" /><div className="art-list"><div className="art-label"><Sparkles />A FRESH START</div><span><i className="art-check"><Check /></i>A little more focus</span><span><i className="art-check"><Check /></i>A little less clutter</span><span><i className="art-circle" />Room for what matters</span></div><span className="art-sparkle"><Sparkles /></span></div>
              <span className="pill"><ShieldCheck />YOUR OWN PRIVATE WORKSPACE</span>
              <h2>Good things start<br />with a small step.</h2>
              <p>Keep your to-dos in one place. Check off the little wins.<br className="desktop-break" /> Sign in with your Microsoft account to make it yours.</p>
              <a className="primary-button" href="/auth/login"><MicrosoftIcon />Sign in with Microsoft<ArrowRight /></a>
              <span className="welcome-footnote">Secure sign-in with Microsoft Entra ID. No new password needed.</span>
            </section>
            <div className="feature-row"><span><ListTodo />Simple by design</span><span><ShieldCheck />Private to you</span><span><Moon />Light & dark mode</span></div>
          </> : <>
            <section className="stats" aria-label="Task overview">
              <Stat label="Total tasks" value={todos.length} icon={<ClipboardList />} detail="Everything in your space" />
              <Stat label="In progress" value={active} icon={<Circle />} detail="One small step at a time" accent="amber" />
              <Stat label="Completed" value={completed} icon={<CheckCheck />} detail="Little wins worth celebrating" accent="green" />
            </section>
            <section className="tasks-card" aria-labelledby="tasks-heading">
              <div className="tasks-heading"><div><h2 id="tasks-heading">My tasks <span className="count-badge">{todos.length}</span></h2><p>Big ideas start with little checkboxes.</p></div><span className="private-label"><ShieldCheck />Only visible to you</span></div>
              <form className="add-form" onSubmit={addTodo}><Plus /><label className="sr-only" htmlFor="new-task">New task</label><input id="new-task" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What's on your mind?" maxLength={200} required disabled={busy} autoComplete="off" /><button className="primary-button" disabled={busy || !title.trim()}><Plus /><span>Add task</span></button></form>
              <div className="task-toolbar"><div className="filters" aria-label="Filter tasks">
                {(["all", "active", "completed"] as const).map((value) => <button key={value} className={filter === value ? "selected" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "all" ? "All tasks" : value === "active" ? "Active" : "Completed"}<span>{value === "all" ? todos.length : value === "active" ? active : completed}</span></button>)}
              </div><label className="search"><Search /><span className="sr-only">Search tasks</span><input type="search" placeholder="Search tasks..." value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
              <div className="task-list" aria-live="polite">
                {visible.length ? visible.map((todo) => <div className={`task-row ${todo.completed ? "is-complete" : ""}`} key={todo.id}>
                  <button className="task-checkbox" aria-label={`${todo.completed ? "Mark active" : "Complete"}: ${todo.title}`} aria-pressed={todo.completed} disabled={busy} onClick={() => void updateTodo(todo, { completed: !todo.completed })}>{todo.completed && <Check />}</button>
                  <span className="task-title">{todo.title}</span>
                  <div className="task-actions"><button className="icon-button" aria-label={`Edit: ${todo.title}`} disabled={busy} onClick={() => { setEditing(todo); setEditTitle(todo.title); }}><Edit3 /></button><button className="icon-button delete" aria-label={`Delete: ${todo.title}`} disabled={busy} onClick={() => deleteTodo(todo)}><Trash2 /></button></div>
                </div>) : <div className="empty-state"><span className="empty-icon">{todos.length === 0 ? <Sparkles /> : <Search />}</span><h3>{todos.length === 0 ? "A fresh page, just for you." : "Nothing here just yet."}</h3><p>{todos.length === 0 ? "Add your first task above. Something small is a great start." : "Try another filter or search to find your tasks."}</p></div>}
              </div>
              <div className="tasks-footer"><span>{active} {active === 1 ? "task" : "tasks"} left to do</span><span><Sparkles />Progress, not perfection.</span></div>
            </section>
            <p className="workspace-note"><ShieldCheck />Your tasks and appearance settings belong to your Microsoft account.</p>
          </>}
      </main>

      <footer className="site-footer"><span><Cloud />One container. A little possibility.</span><span>Demo workspace <span className="footer-dot">/</span> Data resets when the container is replaced</span></footer>

      {panel === "profile" && user && <Modal title="Your profile" close={() => setPanel(null)} error={error}>
        <div className="profile-hero"><span className="avatar large">{initials(user.name)}</span><h3>{user.name}</h3><span className="pill"><span className="status-dot" />Signed in</span></div>
        <dl className="profile-details"><dt>Microsoft account</dt><dd>{user.email || "No email provided"}</dd><dt>Authentication</dt><dd>Microsoft Entra ID</dd></dl>
        <p className="dialog-note"><ShieldCheck />Your identity is managed by Microsoft. Your tasks are private to this account.</p>
      </Modal>}
      {panel === "settings" && user && <Modal title="Settings" close={() => setPanel(null)} error={error}>
        <p className="dialog-description">Make this little space feel like you.</p>
        <div className="setting-row"><span className="setting-icon">{theme === "dark" ? <Moon /> : <Sun />}</span><div><h3>Dark mode</h3><p>A softer view for after-hours focus.</p></div><button className={`toggle ${theme === "dark" ? "on" : ""}`} role="switch" aria-checked={theme === "dark"} aria-label="Dark mode" disabled={busy} onClick={changeTheme}><span /></button></div>
        <p className="dialog-note">Your preference is saved to your account in this demo's database.</p>
      </Modal>}
      {editing && <Modal title="Edit task" close={() => { if (!busy) setEditing(null); }} error={error}>
        <form className="edit-form" onSubmit={(event) => { event.preventDefault(); if (editTitle.trim()) void updateTodo(editing, { title: editTitle.trim() }); }}>
          <label htmlFor="edit-title">Task name</label><input id="edit-title" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={200} required autoFocus disabled={busy} />
          <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button><button className="primary-button" disabled={busy || !editTitle.trim()}>Save changes<Check /></button></div>
        </form>
      </Modal>}
      <span className="sr-only" role="status">{busy ? "Saving changes..." : ""}</span>
    </div>
  );
}

function Stat({ label, value, icon, detail, accent = "violet" }: { label: string; value: number; icon: ReactNode; detail: string; accent?: string }) {
  return <div className={`stat-card ${accent}`}><div className="stat-top"><span>{label}</span><span className="stat-icon">{icon}</span></div><strong>{value.toString().padStart(2, "0")}</strong><p>{detail}</p></div>;
}

function MicrosoftIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="microsoft-icon"><path fill="#f25022" d="M1 1h10v10H1z" /><path fill="#7fba00" d="M13 1h10v10H13z" /><path fill="#00a4ef" d="M1 13h10v10H1z" /><path fill="#ffb900" d="M13 13h10v10H13z" /></svg>;
}
