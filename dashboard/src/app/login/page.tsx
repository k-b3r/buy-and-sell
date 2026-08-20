export default function LoginPage() {
  return (
    <form method="POST" action="/api/login" style={{ maxWidth: 320 }}>
      <h1>Dashboard login</h1>
      <input type="password" name="password" placeholder="Password" autoFocus required style={{ width: '100%', padding: 8 }} />
      <button type="submit" style={{ marginTop: 8, padding: '8px 16px' }}>
        Log in
      </button>
    </form>
  )
}
