# Vybertron

Vybertron is a Discord bot designed to bring good vibes to your server by streaming music from various platforms. Inspired by the home world of the Transformers, Vybertron transforms your server into a musical haven.

## Features

- Play songs from YouTube
- Add songs to the queue
- Skip songs
- View the current queue
- Stop the music and clear the queue
- Adjust the volume

## Getting Started

These instructions will help you set up and run Vybertron on your local machine for development and testing purposes.

### Prerequisites

- Node.js v16.6.0 or higher
- A Discord bot token (you can create one on the [Discord Developer Portal](https://discord.com/developers/applications))
- An .env file with the following variables:
  ```
  DISCORD_BOT_TOKEN=your-discord-bot-token
  ```

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/vybertron.git
   cd vybertron
   ```

2. Install the dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory and add your Discord bot token:
   ```env
   DISCORD_BOT_TOKEN=your-discord-bot-token
   ```

### Running the Bot

To start the bot, run:
```bash
npm start
```

### Commands

The bot supports the following commands:

- `!play <song>`: Plays a song or adds it to the queue.
- `!playnext <song>`: Plays a song next, before other queued songs.
- `!skip`: Skips the current song.
- `!skipto <position>`: Skips to a specific position in the queue.
- `!stop`: Stops the music and clears the queue.
- `!queue`: Displays the current queue.
- `!volume <level>`: Adjusts the volume (0-100).

## Project Structure

```
.
├── src
│   ├── commands
│   │   ├── index.js
│   │   ├── play.js
│   │   ├── playnext.js
│   │   ├── queue.js
│   │   ├── skip.js
│   │   ├── skipto.js
│   │   ├── stop.js
│   │   └── volume.js
│   ├── index.js
│   ├── player.js
├── deploy-commands.js
├── package.json
├── .env
```

## License

This project is licensed under the MIT License.

## Acknowledgements

- [discord.js](https://discord.js.org/)
- [discord-player](https://discord-player.js.org/)
