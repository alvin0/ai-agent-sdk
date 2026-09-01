import { readFile } from 'node:fs/promises'
export const nodeLeak = { readFile, process }
