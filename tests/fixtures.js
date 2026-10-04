export function track(id = 'abcdefghijk', requesterId = '200') {
  return { encoded: `encoded-${id}`, requester: { id: requesterId, username: 'Listener', token: 'never-save-me' }, userData: { secret: 'never-save-this-either' }, pluginInfo: {}, info: {
    sourceName: 'youtube', identifier: id, uri: `https://www.youtube.com/watch?v=${id}&token=never-save-url-token`, title: `Song ${id}`, author: 'Artist', duration: 180_000, isStream: false, isSeekable: true,
  } };
}
