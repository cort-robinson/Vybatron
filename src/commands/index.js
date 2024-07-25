import play from './play.js';
import playnext from './playnext.js';
import skip from './skip.js';
import skipto from './skipto.js';
import stop from './stop.js';
import queue from './queue.js';
import volume from './volume.js';

export function loadCommands(client) { 
  client.on('messageCreate', async (message) => {
    if (!message.guild || !message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    switch (command) {
      case 'play':
        play(message, args);
        break;
      case 'playnext':
        playnext(message, args);
        break;
      case 'skip':
        skip(message);
        break;
      case 'skipto':
        skipto(message, args);
        break;
      case 'stop':
        stop(message);
        break;
      case 'queue':
        queue(message);
        break;
      case 'volume':
        volume(message, args);
        break;
      default:
        message.reply('Unknown command');
        break;
    }
  });
}
