import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseManifest, resolvePluginAsset } from '../src/main/plugins/manifest';
import { manifestSigningPayload, verifyManifestSignature } from '../src/main/plugins/signature';
import { sanitizePluginSvg } from '../src/main/plugins/svg';
import { validateThemeCss } from '../src/main/plugins/theme-css';
import { loadPlugins } from '../src/main/plugins/registry';
import { CapabilityManager } from '../src/main/plugins/capabilities';

const validManifest = {
  id: 'demo-plugin',
  name: 'Demo',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['read:email-meta'],
};

const tempDirs: string[] = [];

function makePluginDir(id: string, manifest: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mf-plugin-${id}-`));
  tempDirs.push(root);
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('manifest 校验（§13.1）', () => {
  it('接受合法 manifest', () => {
    expect(parseManifest(validManifest).ok).toBe(true);
  });

  it('拒绝未知字段、非法 id 与路径穿越', () => {
    expect(parseManifest({ ...validManifest, extra: true }).ok).toBe(false);
    expect(parseManifest({ ...validManifest, id: 'Bad ID' }).ok).toBe(false);
    expect(
      parseManifest({
        ...validManifest,
        contributes: { readerView: '../../evil.html' },
      }).ok,
    ).toBe(false);
  });

  it('资源路径不能逃逸插件目录', () => {
    expect(resolvePluginAsset('/plugins/demo', 'view.html')).toContain('view.html');
    expect(resolvePluginAsset('/plugins/demo', '../secret.txt')).toBeNull();
    expect(resolvePluginAsset('/plugins/demo', 'C:/Windows/win.ini')).toBeNull();
  });
});

describe('manifest 签名（§30.1）', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  function signManifest(manifest: Record<string, unknown>): string {
    return sign(null, manifestSigningPayload(manifest), privateKey).toString('base64');
  }

  it('合法签名通过验证', () => {
    const signature = signManifest(validManifest);
    expect(verifyManifestSignature(validManifest, signature, publicKeyPem).status).toBe('verified');
  });

  it('篡改 permissions 后验签失败', () => {
    const signature = signManifest(validManifest);
    const tampered = { ...validManifest, permissions: ['read:email-body', 'write:draft'] };
    expect(verifyManifestSignature(tampered, signature, publicKeyPem).status).toBe('invalid');
  });

  it('无签名标记为 unsigned，有签名无公钥标记 invalid', () => {
    expect(verifyManifestSignature(validManifest, null, publicKeyPem).status).toBe('unsigned');
    const signature = signManifest(validManifest);
    expect(verifyManifestSignature(validManifest, signature, null).status).toBe('invalid');
  });
});

describe('插件 SVG 净化（§13.6）', () => {
  it('剥离 script、on*、foreignObject 与 javascript:', () => {
    const result = sanitizePluginSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject><div>x</div></foreignObject><circle onload="alert(2)" r="4"/><a href="javascript:alert(3)"><text>t</text></a></svg>',
    );
    expect(result.ok).toBe(true);
    expect(result.svg.toLowerCase()).not.toContain('<script');
    expect(result.svg.toLowerCase()).not.toContain('foreignobject');
    expect(result.svg.toLowerCase()).not.toContain('onload');
    expect(result.svg.toLowerCase()).not.toContain('javascript:');
    expect(result.svg).toContain('<circle');
  });

  it('拒绝非 SVG 与超大文件', () => {
    expect(sanitizePluginSvg('<div>not svg</div>').ok).toBe(false);
    expect(sanitizePluginSvg(`<svg>${'x'.repeat(110 * 1024)}</svg>`).ok).toBe(false);
  });
});

describe('主题 CSS 安全检查（§13.5）', () => {
  it('接受变量覆盖', () => {
    expect(validateThemeCss(':root{--mf-color-bg:#000;}').ok).toBe(true);
  });

  it('注释中的示例文本不会触发规则', () => {
    expect(validateThemeCss('/* 本主题不含 @import 与 url(http) */\n:root{--mf-color-bg:#000;}').ok).toBe(
      true,
    );
  });

  it('拒绝 @import、远程 url 与 expression', () => {
    for (const css of [
      '@import url(https://evil.example/a.css);',
      ':root{background:url(http://evil.example/a.png)}',
      ':root{background:url(//evil.example/a.png)}',
      ':root{width:expression(alert(1))}',
      ':root{background:url(javascript:alert(1))}',
      '</style><script>alert(1)</script>',
    ]) {
      expect(validateThemeCss(css).ok, css).toBe(false);
    }
  });
});

describe('插件注册表加载（§13.1、§13.9）', () => {
  it('加载无签名插件并告警', async () => {
    const dir = makePluginDir('demo-plugin', validManifest);
    const result = await loadPlugins({ dirs: [{ path: path.dirname(dir), source: 'dev' }] });
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]?.status).toBe('ready');
    expect(result.plugins[0]?.signature).toBe('unsigned');
    expect(result.warnings.some((warning) => warning.includes('未签名'))).toBe(true);
  });

  it('损坏 manifest 不崩溃，标记 invalid', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-plugin-broken-'));
    tempDirs.push(root);
    const dir = path.join(root, 'broken');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not json', 'utf8');

    const result = await loadPlugins({ dirs: [{ path: root, source: 'dev' }] });
    expect(result.plugins[0]?.status).toBe('invalid');
    expect(result.plugins[0]?.error).toContain('JSON');
  });

  it('API 版本不兼容时不加载', async () => {
    const dir = makePluginDir('future-plugin', { ...validManifest, id: 'future-plugin', apiVersion: 99 });
    const result = await loadPlugins({ dirs: [{ path: path.dirname(dir), source: 'dev' }] });
    expect(result.plugins[0]?.status).toBe('incompatible');
  });

  it('初始化超时被禁用，其它插件继续加载', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-plugin-timeout-'));
    tempDirs.push(root);
    for (const id of ['slow-plugin', 'fast-plugin']) {
      const dir = path.join(root, id);
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, 'manifest.json'),
        JSON.stringify({ ...validManifest, id }),
        'utf8',
      );
    }

    const result = await loadPlugins({
      dirs: [{ path: root, source: 'dev' }],
      timeoutMs: 80,
      concurrency: 2,
      readText: async (filePath) => {
        if (filePath.includes('slow-plugin')) {
          return new Promise<string>(() => {
            // 永不 resolve，模拟初始化卡死
          });
        }
        return fs.promises.readFile(filePath, 'utf8');
      },
    });

    const slowPlugin = result.plugins.find((plugin) => plugin.manifest.id === 'slow-plugin');
    const fastPlugin = result.plugins.find((plugin) => plugin.manifest.id === 'fast-plugin');
    expect(slowPlugin?.status).toBe('timeout');
    expect(fastPlugin?.status).toBe('ready');
  });
});

describe('能力句柄（§30.5）', () => {
  it('重握手后旧 nonce 失效', () => {
    const manager = new CapabilityManager();
    const first = manager.handshake(1, 'demo-plugin', ['read:email-meta']);
    expect(manager.resolve(1, first.nonce)?.pluginId).toBe('demo-plugin');

    const second = manager.handshake(1, 'demo-plugin', ['read:email-meta']);
    expect(manager.resolve(1, first.nonce)).toBeNull();
    expect(manager.resolve(1, second.nonce)?.nonce).toBe(second.nonce);
  });

  it('撤销权限后调用被拒绝', () => {
    const manager = new CapabilityManager();
    manager.handshake(2, 'demo-plugin', ['read:email-meta', 'read:email-body']);
    const session = manager.getSession(2);
    expect(session).not.toBeNull();
    expect(manager.hasPermission(session!, 'read:email-body')).toBe(true);

    manager.setRevoked('demo-plugin', 'read:email-body', true);
    expect(manager.hasPermission(session!, 'read:email-body')).toBe(false);
    expect(manager.hasPermission(session!, 'read:email-meta')).toBe(true);
  });

  it('插件禁用会清空其会话', () => {
    const manager = new CapabilityManager();
    manager.handshake(3, 'demo-plugin', []);
    manager.handshake(4, 'other-plugin', []);
    manager.invalidatePlugin('demo-plugin');
    expect(manager.getSession(3)).toBeNull();
    expect(manager.getSession(4)).not.toBeNull();
  });
});
