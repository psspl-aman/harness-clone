export function ForgeMark() {
  return (
    <span
      aria-hidden="true"
      className="bg-primary text-primary-foreground grid size-[30px] shrink-0 place-items-center rounded-lg"
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none">
        <path
          d="M4 19 11 5h2l7 14M7.3 14h9.4M9.4 19h5.2"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="m19.1 3 .7 1.9 2 .6-2 .7-.7 2-.6-2-2-.7 2-.6z" fill="currentColor" />
      </svg>
    </span>
  );
}
