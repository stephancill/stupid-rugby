import { Link } from "react-router";
import { type Follow, pushSupport, useFollows, useToggleFollow } from "./push.ts";

// On iOS outside the Home Screen app, where follow buttons are hidden.
export function PushHint() {
  if (pushSupport() !== "install") return null;
  return (
    <small className="follow">
      Add this app to your Home Screen to get notifications. <Link to="/notifications">How</Link>
    </small>
  );
}

// Follows `targets` (all at once: several team ids can share a name) for push
// notifications. Subscribes the device on first use.
export function FollowButton({ targets, label }: { targets: Follow[]; label: string }) {
  const follows = useFollows();
  const toggle = useToggleFollow();
  const support = pushSupport();
  // Pages show <PushHint /> once instead.
  if (support !== "supported" || targets.length === 0) return null;
  const following = targets.every((t) =>
    follows.data?.some((f) => f.kind === t.kind && f.target === t.target),
  );
  return (
    <span className="follow">
      <button
        disabled={toggle.isPending || follows.isPending}
        onClick={() => toggle.mutate({ targets, follow: !following })}
      >
        {following ? `🔔 Following ${label}` : `Follow ${label}`}
      </button>
      {toggle.error && <small className="error"> {toggle.error.message}</small>}
    </span>
  );
}
