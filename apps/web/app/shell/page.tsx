"use client";

import { useEffect, useState, type FormEvent } from "react";

type SessionProof =
  | { authenticated: true; tenantId: string; tenantStatus: string; userId: string; role: string }
  | { error: string };

const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function requestProof(): Promise<SessionProof> {
  const response = await fetch(`${apiOrigin}/session-proof`, { credentials: "include" });
  return (await response.json()) as SessionProof;
}

export default function ShellPage() {
  const [proof, setProof] = useState<SessionProof | null>(null);
  const [legalName, setLegalName] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void requestProof()
      .then((value) => {
        setProof(value);
      })
      .catch(() => {
        setProof({ error: "session_unavailable" });
      });
  }, []);

  async function provision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const response = await fetch(`${apiOrigin}/onboarding`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ legalName })
    });
    if (!response.ok) {
      setMessage("Tenant setup could not be completed.");
      return;
    }
    setProof(await requestProof());
  }

  return (
    <main>
      <section className="panel">
        <p className="eyebrow">Foundation shell</p>
        <h1>Tenant session</h1>
        {proof === null ? (
          <p>Checking session...</p>
        ) : "error" in proof ? (
          <form
            onSubmit={(event) => {
              void provision(event);
            }}
          >
            <p>Complete the one-time tenant setup for this verified identity.</p>
            <label htmlFor="legalName">Legal business name</label>
            <input
              id="legalName"
              required
              value={legalName}
              onChange={(event) => {
                setLegalName(event.target.value);
              }}
            />
            <button type="submit">Create tenant</button>
            <p role="status">{message}</p>
          </form>
        ) : (
          <>
            <dl>
              <dt>Authenticated</dt>
              <dd>Yes</dd>
              <dt>Tenant status</dt>
              <dd>{proof.tenantStatus}</dd>
              <dt>Role</dt>
              <dd>{proof.role}</dd>
              <dt>Tenant context</dt>
              <dd>
                <code>{proof.tenantId}</code>
              </dd>
            </dl>
            <p>
              <a href="/catalog">Open catalog operations</a>
            </p>
          </>
        )}
      </section>
    </main>
  );
}
