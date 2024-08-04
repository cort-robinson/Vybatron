import {dirname} from 'path';
import {fileURLToPath} from 'url';

export const getFilename = (url: string) => fileURLToPath(url);
export const getDirname = (url: string) => dirname(fileURLToPath(url));