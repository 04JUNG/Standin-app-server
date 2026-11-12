import { readFileSync, writeFileSync } from 'node:fs';
// An absent setting preserves an explicitly provisioned task; production is never touched.
const [file] = process.argv.slice(2);
const enabled = process.env.STAGING_INTERACTIVE_STATE_ENABLED;
if (enabled !== undefined && enabled !== '') {
  if (process.env.GITHUB_REF === 'refs/heads/main' || !process.env.GITHUB_REF?.startsWith('refs/heads/')) throw new Error('Staging interactive configuration only');
  if (!['true', 'false'].includes(enabled)) throw new Error('Expected true or false');
  const task = JSON.parse(readFileSync(file, 'utf8'));
  const bff = task.containerDefinitions.find(c => c.name === 'bff');
  if (!bff) throw new Error('Missing BFF');
  if (enabled === 'true' && (!bff.environment?.some(e => e.name === 'CONVERTER_BASE_URL' && e.value?.trim()) || !bff.secrets?.some(s => s.name === 'CONVERTER_INTERACTIVE_TOKEN' && s.valueFrom?.includes(':secret:standin/staging/')))) throw new Error('Provision staging private Converter URL and dedicated secret first');
  bff.environment = [...(bff.environment ?? []).filter(e => e.name !== 'INTERACTIVE_STATE_ENABLED'), {name: 'INTERACTIVE_STATE_ENABLED', value: enabled}];
  writeFileSync(file, JSON.stringify(task, null, 2) + '\n');
}
