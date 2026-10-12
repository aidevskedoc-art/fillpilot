/** The FillPilot mark: a bolt on the brand gradient (same drawing as icons/icon-*.png). */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="currentColor">
        <path d="M13 2 4.5 13.5H11l-1 8.5 9.5-12.5H13z" />
      </svg>
    </span>
  );
}
