import { expect, test } from './test';

// A loopback build and simulated Discord parent exercise the real SDK handshake.
test('Discord Activity follows the room and stows the canvas when the listener leaves', async ({ page, request, baseURL }, testInfo) => {
  const origin = 'https://123456789012345678.discordsays.com';
  let inVoice = true;
  await page.route(origin + '/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/.proxy/token') return route.fulfill({ json: { access_token: 'test-identify', token: 'test-room' } });
    if (path === '/.proxy/room/100') {
      expect(route.request().headers().authorization).toBe('Bearer test-room');
      return route.fulfill({ status: inVoice ? 200 : 403, json: inVoice ? {
        track: { title: 'Night Signal', artist: 'Polar Avenue', id: 'test-track', video: null },
        playing: true, positionMs: 60000, rate: 1,
      } : {} });
    }
    const file = path === '/' ? 'activity.html' : path.replace('/.proxy/', '');
    const response = await request.get(baseURL + '/activity-host/' + file);
    return route.fulfill({ response });
  });
  await page.route('https://discord.com/test-activity', route => route.fulfill({ contentType: 'text/html', body: `
    <style>*{box-sizing:border-box}body{margin:0}iframe{width:100vw;height:100vh;border:0}</style>
    <script>
      window.addEventListener('message', event => {
        if (event.origin !== '${origin}' || !Array.isArray(event.data)) return;
        const [op, msg] = event.data;
        const send = payload => event.source.postMessage([1, payload], event.origin);
        if (op === 0) return send({cmd:'DISPATCH',evt:'READY',nonce:null,data:{v:1,config:{api_endpoint:'test',environment:'test'}}});
        if (op !== 1) return;
        const data = msg.cmd === 'AUTHORIZE' ? {code:'test-code'} : msg.cmd === 'AUTHENTICATE' ? {
          access_token:'test-identify', scopes:['identify'], expires:'2099-01-01',
          user:{id:'200',username:'Listener',discriminator:'0',public_flags:0},application:{id:'123456789012345678',name:'Vybatron',description:''}
        } : {};
        send({cmd:msg.cmd,nonce:msg.nonce,evt:null,data});
      });
    </script>
    <iframe title="Room visualizer" src="${origin}/?frame_id=one&instance_id=two&platform=desktop&guild_id=100"></iframe>` }));
  await page.setViewportSize({ width: 820, height: 575 });
  await page.goto('https://discord.com/test-activity');
  const stage = page.frameLocator('iframe');
  await expect(stage.getByRole('heading', { name: 'Night Signal' })).toBeVisible();
  await expect(stage.getByText('Ambient motion')).toBeVisible();
  await expect(stage.locator('canvas[data-drawn]')).toBeVisible({ timeout: 15000 });
  await stage.getByRole('button', { name: 'Pause motion' }).click();
  await expect(stage.getByRole('button', { name: 'Resume motion' })).toBeVisible();
  const preset = await stage.locator('#preset').textContent();
  await stage.getByRole('button', { name: 'Next preset' }).click();
  await expect(stage.locator('#preset')).not.toHaveText(preset || '');
  await page.screenshot({ path: testInfo.outputPath('activity.png') });
  inVoice = false;
  await expect(stage.getByRole('heading', { name: /Join the bot/ })).toBeVisible();
  await expect(stage.locator('canvas')).toBeHidden();
});
