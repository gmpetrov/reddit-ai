import { api, fmt, Empty, Act } from './util';

function ProfileState({ p, s }) {
  if (s?.lockedBy) return <span className="state agent live">Agent is using this browser</span>;
  if (s) return <span className="state agent live">Browser open</span>;
  if (p.hasSavedSession) return <span className="state ok">Login saved {fmt(p.savedAt)}</span>;
  return <span className="state idle">Not logged in</span>;
}

export default function Profiles({ active, profiles, sessionOf, act, toast, loadAll, openLive }) {
  const add = act(async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const fd = new FormData(f);
    await api('POST', '/api/profiles', { name: fd.get('name'), startUrl: fd.get('startUrl') });
    f.reset();
  });

  return (
    <section className={`tab${active ? ' active' : ''}`}>
      <div className="section-head">
        <h1>Profiles</h1>
        <p className="lede">A profile is a saved login. Open its browser, sign in yourself, then save and close. Cookies and local storage are encrypted and restored every time the profile opens.</p>
      </div>
      <form className="panel composer-inline" onSubmit={add}>
        <label className="field grow">
          <span className="label">Name</span>
          <input name="name" placeholder="Reddit, main account" required maxLength={100} />
        </label>
        <label className="field grow-2">
          <span className="label">Login page</span>
          <input name="startUrl" className="mono" placeholder="https://www.reddit.com/login" inputMode="url" />
        </label>
        <button className="primary">Add profile</button>
      </form>
      <div className="list">
        {!profiles.length ? (
          <Empty title="No profiles yet">Add one above with its login page, for example https://www.reddit.com/login.</Empty>
        ) : (
          profiles.map((p) => {
            const s = sessionOf(p.id);
            return (
              <div className="item" key={p.id}>
                <div className="meta">
                  <div className="title">{p.name}</div>
                  <div>
                    <ProfileState p={p} s={s} />
                  </div>
                  {p.startUrl && <div className="url">{p.startUrl}</div>}
                </div>
                <div className="btns">
                  {s ? (
                    <>
                      <button className="primary" onClick={() => openLive(p.id)}>
                        View browser
                      </button>
                      <Act
                        disabled={!!s.lockedBy}
                        title={s.lockedBy ? 'The agent is using this browser' : undefined}
                        onClick={act(async () => {
                          await api('POST', `/api/profiles/${p.id}/close`, { save: true });
                          toast('Login saved and browser closed');
                        })}
                      >
                        Save and close
                      </Act>
                    </>
                  ) : (
                    <Act
                      className="primary"
                      onClick={act(async () => {
                        toast('Starting the cloud browser. This can take about 20 seconds.');
                        await api('POST', `/api/profiles/${p.id}/open`);
                        await loadAll();
                        openLive(p.id);
                      })}
                    >
                      {p.hasSavedSession ? 'Open browser' : 'Open and log in'}
                    </Act>
                  )}
                  {p.hasSavedSession && !s && (
                    <Act
                      className="ghost"
                      onClick={act(async () => {
                        if (!confirm('Forget the saved login? You’ll need to sign in again next time.')) return;
                        await api('POST', `/api/profiles/${p.id}/clear`);
                      })}
                    >
                      Forget login
                    </Act>
                  )}
                  <Act
                    className="ghost danger"
                    onClick={act(async () => {
                      if (!confirm('Delete this profile and its saved login?')) return;
                      await api('DELETE', `/api/profiles/${p.id}`);
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
