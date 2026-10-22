// Controlled executable: reports wrapper inputs, never starts Pi or Paseo.
console.log(JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith('PI_PASEO_') || key.startsWith('PASEO_')),
) }));
