import { useRef, useState } from 'react';
import { api, ACTIVE, Empty, Act } from './util';

const BLANK = { id: '', name: '', profileId: '', startUrl: '', maxSteps: '30', instructions: '' };

export default function Tasks({ active, profiles, tasks, runs, act, toast, showTab }) {
  const [form, setForm] = useState(BLANK);
  const formRef = useRef(null);
  const instructionsRef = useRef(null);
  const editing = Boolean(form.id);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const profileName = (pid) => profiles.find((p) => p.id === pid)?.name || '(deleted profile)';

  function edit(t) {
    setForm(Object.fromEntries(Object.keys(BLANK).map((k) => [k, String(t[k] ?? '')])));
    formRef.current.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    instructionsRef.current.focus({ preventScroll: true });
  }

  const submit = act(async (e) => {
    e.preventDefault();
    const { id, ...body } = form;
    if (id) await api('PUT', `/api/tasks/${id}`, body);
    else await api('POST', '/api/tasks', body);
    toast(id ? 'Changes saved' : 'Task created');
    setForm(BLANK);
  });

  return (
    <section className={`tab${active ? ' active' : ''}`}>
      <div className="section-head">
        <h1>Tasks</h1>
        <p className="lede">Tell the agent what to do in plain words. It drives the profile's browser and stops to ask you when it needs a person: two-factor codes, CAPTCHAs, or anything you asked it to confirm.</p>
      </div>
      <form ref={formRef} className={`panel task-form${editing ? ' editing' : ''}`} onSubmit={submit}>
        <h2>{editing ? `Edit ${tasks.find((t) => t.id === form.id)?.name ?? form.name}` : 'New task'}</h2>
        <label className="field">
          <span className="label">Name</span>
          <input name="name" placeholder="Weekly r/webscraping digest" required maxLength={100} value={form.name} onChange={set('name')} />
        </label>
        <label className="field">
          <span className="label">Instructions</span>
          <textarea
            ref={instructionsRef}
            name="instructions"
            rows={4}
            required
            placeholder="Go to r/webscraping, open the top 3 posts of the week and summarize them. Don't post anything."
            value={form.instructions}
            onChange={set('instructions')}
          />
        </label>
        <div className="task-opts">
          <label className="field">
            <span className="label">Profile</span>
            <select name="profileId" required value={form.profileId} onChange={set('profileId')}>
              <option value="">{profiles.length ? 'Choose a profile' : 'Add a profile first'}</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span className="label">
              Start page <span className="opt">optional</span>
            </span>
            <input name="startUrl" className="mono" placeholder="https://www.reddit.com/r/webscraping" inputMode="url" value={form.startUrl} onChange={set('startUrl')} />
          </label>
          <label className="field steps-field">
            <span className="label">Step limit</span>
            <input name="maxSteps" type="number" min={1} max={100} value={form.maxSteps} onChange={set('maxSteps')} />
          </label>
        </div>
        <div className="actions">
          {editing && (
            <button type="button" className="ghost" onClick={() => setForm(BLANK)}>
              Cancel
            </button>
          )}
          <button className="primary">{editing ? 'Save changes' : 'Create task'}</button>
        </div>
      </form>
      <div className="list">
        {!tasks.length ? (
          <Empty title="No tasks yet">Write your first one above. The agent can browse, click, type and scroll, and it asks before anything it can’t do alone.</Empty>
        ) : (
          tasks.map((t) => {
            const busy = runs.some((r) => r.taskId === t.id && ACTIVE.includes(r.status));
            return (
              <div className="item" key={t.id}>
                <div className="meta">
                  <div className="title">
                    {t.name} <span className="chip">{profileName(t.profileId)}</span>
                  </div>
                  <div className="sub clamp">{t.instructions}</div>
                </div>
                <div className="btns">
                  <Act
                    className="primary"
                    disabled={busy}
                    title={busy ? 'Already running' : undefined}
                    onClick={act(async () => {
                      await api('POST', `/api/tasks/${t.id}/run`);
                      showTab('runs');
                    })}
                  >
                    {busy ? 'Running' : 'Run'}
                  </Act>
                  <button onClick={() => edit(t)}>Edit</button>
                  <Act
                    className="ghost danger"
                    onClick={act(async () => {
                      if (!confirm('Delete this task?')) return;
                      await api('DELETE', `/api/tasks/${t.id}`);
                    })}
                  >
                    Delete
                  </Act>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
