import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <h1>Zabuni</h1>
      <p>Foundation environment ready.</p>
      <Link href="/sign-in">Sign in</Link>
    </main>
  );
}
