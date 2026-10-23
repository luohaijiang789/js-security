export default async function Page() {
  const response = await fetch('/v1/server', { headers: { 'X-Server': 'yes' } });
  return <div>Server user</div>;
}
