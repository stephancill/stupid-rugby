import { Link } from "react-router";
import {
  type FollowKind,
  pushSupport,
  useDisablePush,
  useFollows,
  usePushSubscription,
  useToggleFollow,
} from "./push.ts";

const kindLabels: Record<FollowKind, string> = {
  team: "Teams",
  match: "Matches",
  competition: "Competitions (kick-off and full time only)",
};

// What this device follows, with unfollow and a switch to stop all notifications.
export function NotificationsPage() {
  const subscription = usePushSubscription();
  const follows = useFollows();
  const toggle = useToggleFollow();
  const disable = useDisablePush();
  const support = pushSupport();

  return (
    <main className="notifications">
      <p>
        <Link to="/">← All matches</Link>
      </p>
      <h1>Notifications</h1>
      {support === "unsupported" && <p>This browser doesn't support push notifications.</p>}
      {support === "install" && (
        <p>
          On iPhone and iPad, notifications need the app on your Home Screen: tap Share → Add to
          Home Screen, then open it from there.
        </p>
      )}
      {support === "supported" && (
        <>
          <p>
            Follow teams and matches for kick-off, every score, half-time and full time. Follow
            competitions for kick-off and full time. Use the Follow buttons on match, team and
            competition pages.
          </p>
          {follows.error && <p className="error">{follows.error.message}</p>}
          {!subscription.data ? (
            <p>Notifications are off on this device.</p>
          ) : follows.data?.length === 0 ? (
            <p>Not following anything yet.</p>
          ) : (
            (["team", "match", "competition"] as const).map((kind) => {
              const list = follows.data?.filter((f) => f.kind === kind) ?? [];
              if (list.length === 0) return null;
              return (
                <section key={kind}>
                  <h2>{kindLabels[kind]}</h2>
                  <ul>
                    {list.map((f) => (
                      <li key={f.target}>
                        {f.label}{" "}
                        <button
                          disabled={toggle.isPending}
                          onClick={() => toggle.mutate({ targets: [f], follow: false })}
                        >
                          Unfollow
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })
          )}
          {subscription.data && (
            <p>
              <button disabled={disable.isPending} onClick={() => disable.mutate()}>
                Turn off notifications on this device
              </button>
              {disable.error && <small className="error"> {disable.error.message}</small>}
            </p>
          )}
        </>
      )}
    </main>
  );
}
