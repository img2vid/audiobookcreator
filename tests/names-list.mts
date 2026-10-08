import { readFileSync } from 'node:fs';
import { discoverCharacterNames } from '@/lib/engines/autobook';
const text = readFileSync('/tmp/pnp.txt', 'utf-8');
console.log(JSON.stringify(discoverCharacterNames(text)));
