// node --import ./adapter-loader.mjs ...   (see adapter-hooks.mjs)
import { register } from 'node:module';
register('./adapter-hooks.mjs', import.meta.url);
