async function main() {
  const module=await import('./feature.js');
  return module.load({id:7});
}
main();
