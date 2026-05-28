/**
 * SillyTavern Incremental Save — Server Plugin
 *
 * Registers /save-append and /group/save-append routes.
 * Companion to the client-side extension that intercepts save requests.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import sanitize from 'sanitize-filename';

/**
 * @param {object} context — SillyTavern server plugin context
 * @param {function} context.registerRouter — register an express router
 * @param {object} context.util — SillyTavern utility functions
 */
export default async function (context) {
    const router = express.Router();
    const { registerRouter } = context;

    // ---- SillyTavern utilities (provided via plugin context) ----
    const tryWriteFileSync = (fp, data) => { try { fs.writeFileSync(fp, data, 'utf8'); } catch {} };
    const tryReadFileSync  = (fp) => { try { return fs.readFileSync(fp, 'utf8'); } catch { return ''; } };

    // ---- Helper: count lines in a file ----
    async function countLines(filePath) {
        return new Promise((resolve, reject) => {
            let count = 0;
            const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
            stream.on('data', (chunk) => {
                for (let i = 0; i < chunk.length; i++) {
                    if (chunk[i] === '\n') count++;
                }
            });
            stream.on('end', () => resolve(count > 0 ? count + 1 : 1));
            stream.on('error', reject);
        });
    }

    // ---- Helper: incrementally append messages ----
    async function tryAppendChat(chatFilePath, header, newMessages, expectedLines) {
        if (!fs.existsSync(chatFilePath)) {
            return { ok: false, error: 'file_not_found' };
        }

        const actualLines = await countLines(chatFilePath);
        if (actualLines !== expectedLines) {
            return { ok: false, error: 'line_mismatch', actualLines };
        }

        const existingData = tryReadFileSync(chatFilePath);
        const firstNewline = existingData.indexOf('\n');
        const restOfFile = firstNewline >= 0 ? existingData.substring(firstNewline) : '';

        const headerLine = JSON.stringify(header);
        const appendData = newMessages.length > 0
            ? '\n' + newMessages.map(m => JSON.stringify(m)).join('\n')
            : '';
        const newData = headerLine + restOfFile + appendData;

        tryWriteFileSync(chatFilePath, newData);
        return { ok: true };
    }

    // ---- Route: single chat append ----
    router.post('/save-append', async function (req, res) {
        try {
            if (!req.user?.profile?.handle) {
                return res.status(401).send({ error: 'Not authenticated' });
            }

            const handle = req.user.profile.handle;
            const cardName = String(req.body.avatar_url || '').replace('.png', '');
            const chatFileName = `${String(req.body.file_name)}.jsonl`;
            const chatFilePath = path.join(
                req.user.directories.chats,
                cardName,
                sanitize(chatFileName),
            );
            const { header, newMessages, expectedLines } = req.body;

            if (!Array.isArray(newMessages)) {
                return res.status(400).send({ error: 'newMessages must be an array.' });
            }

            const result = await tryAppendChat(chatFilePath, header, newMessages, expectedLines);

            if (result.ok) return res.send({ ok: true });
            if (result.error === 'line_mismatch') {
                return res.status(409).send({ error: 'line_mismatch', actualLines: result.actualLines });
            }
            return res.status(400).send({ error: result.error });
        } catch (error) {
            console.error('[IncSave] Incremental save error:', error);
            return res.status(500).send({ error: 'An error occurred during incremental save.' });
        }
    });

    // ---- Route: group chat append ----
    router.post('/group/save-append', async function (req, res) {
        try {
            if (!req.user?.profile?.handle) {
                return res.status(401).send({ error: 'Not authenticated' });
            }

            const id = req.body.id;
            if (!id) return res.sendStatus(400);

            const handle = req.user.profile.handle;
            const chatFilePath = path.join(
                req.user.directories.groupChats,
                sanitize(`${id}.jsonl`),
            );
            const { header, newMessages, expectedLines } = req.body;

            if (!Array.isArray(newMessages)) {
                return res.status(400).send({ error: 'newMessages must be an array.' });
            }

            const result = await tryAppendChat(chatFilePath, header, newMessages, expectedLines);

            if (result.ok) return res.send({ ok: true });
            if (result.error === 'line_mismatch') {
                return res.status(409).send({ error: 'line_mismatch', actualLines: result.actualLines });
            }
            return res.status(400).send({ error: result.error });
        } catch (error) {
            console.error('[IncSave] Incremental group save error:', error);
            return res.status(500).send({ error: 'An error occurred during incremental group save.' });
        }
    });

    // Status endpoint for health check
    router.get('/status', function (req, res) {
        res.send({ ok: true, version: '1.0.0' });
    });

    registerRouter('/api/plugins/incremental-save', router);
    console.log('[IncSave] Server plugin registered: /api/plugins/incremental-save');
}
