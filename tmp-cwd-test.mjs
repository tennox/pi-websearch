process.env.KAGI_API_KEY = ''
process.env.PI_WEBSEARCH_PROVIDER = 'kagi'
const mod = await import('./index.ts')
const tools = []
await mod.default({ on: () => {}, registerTool: (t) => tools.push(t), registerCommand: () => {} })
const ws = tools.find(t => t.name === 'websearch')
const res = await ws.execute('t1', { query: 'test' }, undefined, undefined, { sessionManager: { getSessionFile: () => 'test' } })
console.log('provider:', res.details.provider)
