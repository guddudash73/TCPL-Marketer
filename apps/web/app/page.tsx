import { Button } from "@tcpl-marketer/ui";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6 py-16">
      <p className="text-sm font-semibold tracking-[0.2em] text-sky-700">TCPL MARKETER</p>
      <h1 className="text-4xl font-bold tracking-tight text-slate-950 sm:text-5xl">
        AI lead generation and sales automation
      </h1>
      <p className="max-w-2xl text-lg leading-8 text-slate-600">
        The web workspace is ready for the Day 1 platform foundation.
      </p>
      <div>
        <Button>Platform bootstrap complete</Button>
      </div>
    </main>
  );
}
