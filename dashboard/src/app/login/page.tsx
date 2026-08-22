export default function LoginPage() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '10vh' }}>
      <form
        method="POST"
        action="/api/login"
        style={{
          width: '100%',
          maxWidth: 320,
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          padding: 24,
        }}
      >
        <h1 style={{ fontSize: '1.2rem', marginTop: 0 }}>Dashboard login</h1>
        <input
          type="password"
          name="password"
          placeholder="Password"
          autoFocus
          required
          style={{ width: '100%', padding: 8 }}
        />
        <button type="submit" style={{ marginTop: 12, padding: '8px 16px', width: '100%' }}>
          Log in
        </button>
      </form>
    </div>
  )
}
