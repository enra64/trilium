"use strict";


const Attribute = require('../../entities/attribute');
const utils = require('../../services/utils');
const log = require('../../services/log');
const repository = require('../../services/repository');
const noteService = require('../../services/notes');
const attributeService = require('../../services/attributes');
const Branch = require('../../entities/branch');
const tar = require('tar-stream');
const stream = require('stream');
const path = require('path');
const commonmark = require('commonmark');
const ImportContext = require('../import_context');
const protectedSessionService = require('../protected_session');
const mimeService = require("./mime");

/**
 * @param {ImportContext} importContext
 * @param {Buffer} fileBuffer
 * @param {Note} importRootNote
 * @return {Promise<*>}
 */
async function importTar(importContext, fileBuffer, importRootNote) {
    // maps from original noteId (in tar file) to newly generated noteId
    const noteIdMap = {};
    const attributes = [];
    // path => noteId
    const createdPaths = { '/': importRootNote.noteId, '\\': importRootNote.noteId };
    const mdReader = new commonmark.Parser();
    const mdWriter = new commonmark.HtmlRenderer();
    let metaFile = null;
    let firstNote = null;

    const extract = tar.extract();

    function getNewNoteId(origNoteId) {
        // in case the original noteId is empty. This probably shouldn't happen, but still good to have this precaution
        if (!origNoteId.trim()) {
            return "";
        }

        if (!noteIdMap[origNoteId]) {
            noteIdMap[origNoteId] = utils.newEntityId();
        }

        return noteIdMap[origNoteId];
    }
    
    function getMeta(filePath) {
        if (!metaFile) {
            return {};
        }

        const pathSegments = filePath.split(/[\/\\]/g);

        let cursor = {
            isImportRoot: true,
            children: metaFile.files
        };

        let parent;

        for (const segment of pathSegments) {
            if (!cursor || !cursor.children || cursor.children.length === 0) {
                return {};
            }

            parent = cursor;
            cursor = cursor.children.find(file => file.dataFileName === segment || file.dirFileName === segment);
        }

        return {
            parentNoteMeta: parent,
            noteMeta: cursor
        };
    }

    async function getParentNoteId(filePath, parentNoteMeta) {
        let parentNoteId;

        if (parentNoteMeta) {
            parentNoteId = parentNoteMeta.isImportRoot ? importRootNote.noteId : getNewNoteId(parentNoteMeta.noteId);
        }
        else {
            const parentPath = path.dirname(filePath);

            if (parentPath === '.') {
                parentNoteId = importRootNote.noteId;
            }
            else if (parentPath in createdPaths) {
                parentNoteId = createdPaths[parentPath];
            }
            else {
                // tar allows creating out of order records - i.e. file in a directory can appear in the tar stream before actual directory
                // (out-of-order-directory-records.tar in test set)
                parentNoteId = await saveDirectory(parentPath);
            }
        }

        return parentNoteId;
    }

    function getNoteTitle(filePath, noteMeta) {
        if (noteMeta) {
            return noteMeta.title;
        }
        else {
            const basename = path.basename(filePath);

            return getTextFileWithoutExtension(basename);
        }
    }

    function getNoteId(noteMeta, filePath) {
        let noteId;

        const filePathNoExt = getTextFileWithoutExtension(filePath);

        if (noteMeta) {
            if (filePathNoExt in createdPaths) {
                noteId = createdPaths[filePathNoExt];
                noteIdMap[noteMeta.noteId] = noteId;
            }
            else {
                noteId = getNewNoteId(noteMeta.noteId);
            }
        }
        else {
            if (filePathNoExt in createdPaths) {
                noteId = createdPaths[filePathNoExt];
            }
            else {
                noteId = utils.newEntityId();
            }
        }

        createdPaths[filePathNoExt] = noteId;

        return noteId;
    }

    function detectFileTypeAndMime(importContext, filePath) {
        const mime = mimeService.getMime(filePath);
        const type = mimeService.getType(importContext, mime);

        return { mime, type };
    }

    async function saveAttributes(note, noteMeta) {
        if (!noteMeta) {
            return;
        }

        for (const attr of noteMeta.attributes) {
            attr.noteId = note.noteId;

            if (!attributeService.isAttributeType(attr.type)) {
                log.error("Unrecognized attribute type " + attr.type);
                continue;
            }

            if (attr.type === 'relation') {
                attr.value = getNewNoteId(attr.value);
            }

            if (importContext.safeImport && attributeService.isAttributeDangerous(attr.type, attr.name)) {
                attr.name = 'disabled-' + attr.name;
            }

            attributes.push(attr);
        }
    }

    async function saveDirectory(filePath) {
        const { parentNoteMeta, noteMeta } = getMeta(filePath);

        const noteId = getNoteId(noteMeta, filePath);
        const noteTitle = getNoteTitle(filePath, noteMeta);
        const parentNoteId = await getParentNoteId(filePath, parentNoteMeta);

        let note = await repository.getNote(noteId);

        if (note) {
            return;
        }

        ({note} = await noteService.createNote(parentNoteId, noteTitle, '', {
            noteId,
            type: noteMeta ? noteMeta.type : 'text',
            mime: noteMeta ? noteMeta.mime : 'text/html',
            prefix: noteMeta ? noteMeta.prefix : '',
            isExpanded: noteMeta ? noteMeta.isExpanded : false,
            isProtected: importRootNote.isProtected && protectedSessionService.isProtectedSessionAvailable(),
        }));

        await saveAttributes(note, noteMeta);

        if (!firstNote) {
            firstNote = note;
        }

        return noteId;
    }

    function getTextFileWithoutExtension(filePath) {
        const extension = path.extname(filePath).toLowerCase();

        if (extension === '.md' || extension === '.html') {
            return filePath.substr(0, filePath.length - extension.length);
        }
        else {
            return filePath;
        }
    }

    function getNoteIdFromRelativeUrl(url, filePath) {
        while (url.startsWith("./")) {
            url = url.substr(2);
        }

        let absUrl = path.dirname(filePath);

        while (url.startsWith("../")) {
            absUrl = path.dirname(absUrl);

            url = url.substr(3);
        }

        if (absUrl === '.') {
            absUrl = '';
        }

        absUrl += (absUrl.length > 0 ? '/' : '') + url;

        const targetNoteId = getNoteId(null, absUrl);
        return targetNoteId;
    }

    async function saveNote(filePath, content) {
        const {parentNoteMeta, noteMeta} = getMeta(filePath);

        const noteId = getNoteId(noteMeta, filePath);
        const parentNoteId = await getParentNoteId(filePath, parentNoteMeta);

        if (noteMeta && noteMeta.isClone) {
            await new Branch({
                noteId,
                parentNoteId,
                isExpanded: noteMeta.isExpanded,
                prefix: noteMeta.prefix,
                notePosition: noteMeta.notePosition
            }).save();

            return;
        }

        const {type, mime} = noteMeta ? noteMeta : detectFileTypeAndMime(importContext, filePath);

        if (type !== 'file' && type !== 'image') {
            content = content.toString("UTF-8");
        }

        if ((noteMeta && noteMeta.format === 'markdown') || (!noteMeta && ['text/markdown', 'text/x-markdown'].includes(mime))) {
            const parsed = mdReader.parse(content);
            content = mdWriter.render(parsed);
        }

        const noteTitle = getNoteTitle(filePath, noteMeta);

        if (type === 'text') {
            function isUrlAbsolute(url) {
                return /^(?:[a-z]+:)?\/\//i.test(url);
            }

            content = content.replace(/src="([^"]*)"/g, (match, url) => {
                url = decodeURIComponent(url);

                if (isUrlAbsolute(url) || url.startsWith("/")) {
                    return match;
                }

                const targetNoteId = getNoteIdFromRelativeUrl(url, filePath);

                return `src="api/images/${targetNoteId}/${path.basename(url)}"`;
            });

            content = content.replace(/href="([^"]*)"/g, (match, url) => {
                url = decodeURIComponent(url);

                if (isUrlAbsolute(url)) {
                    return match;
                }

                const targetNoteId = getNoteIdFromRelativeUrl(url, filePath);

                return `href="#root/${targetNoteId}"`;
            });

            content = content.replace(/<html.*<body[^>]*>/gis, "");
            content = content.replace(/<\/body>.*<\/html>/gis, "");

            content = content.replace(/<h1>([^<]*)<\/h1>/gi, (match, text) => {
                if (noteTitle.trim() === text.trim()) {
                    return ""; // remove whole H1 tag
                }
                else {
                    return match;
                }
            });
        }

        if (type === 'relation-map' && noteMeta) {
            const relationMapLinks = (noteMeta.attributes || [])
                .filter(attr => attr.type === 'relation' && attr.name === 'relation-map-link');

            // this will replace relation map links
            for (const link of relationMapLinks) {
                // no need to escape the regexp find string since it's a noteId which doesn't contain any special characters
                content = content.replace(new RegExp(link.value, "g"), getNewNoteId(link.value));
            }
        }

        let note = await repository.getNote(noteId);

        if (note) {
            await note.setContent(content);
        }
        else {
            ({note} = await noteService.createNote(parentNoteId, noteTitle, content, {
                noteId,
                type,
                mime,
                prefix: noteMeta ? noteMeta.prefix : '',
                isExpanded: noteMeta ? noteMeta.isExpanded : false,
                notePosition: noteMeta ? noteMeta.notePosition : false,
                isProtected: importRootNote.isProtected && protectedSessionService.isProtectedSessionAvailable(),
            }));

            await saveAttributes(note, noteMeta);

            if (!noteMeta && (type === 'file' || type === 'image')) {
                attributes.push({
                    noteId,
                    type: 'label',
                    name: 'originalFileName',
                    value: path.basename(filePath)
                });

                attributes.push({
                    noteId,
                    type: 'label',
                    name: 'fileSize',
                    value: content.byteLength
                });
            }

            if (!firstNote) {
                firstNote = note;
            }

            if (type === 'text') {
                filePath = getTextFileWithoutExtension(filePath);
            }
        }
    }

    /** @return {string} path without leading or trailing slash and backslashes converted to forward ones*/
    function normalizeFilePath(filePath) {
        filePath = filePath.replace(/\\/g, "/");

        if (filePath.startsWith("/")) {
            filePath = filePath.substr(1);
        }

        if (filePath.endsWith("/")) {
            filePath = filePath.substr(0, filePath.length - 1);
        }

        return filePath;
    }

    extract.on('entry', function(header, stream, next) {
        const chunks = [];

        stream.on("data", function (chunk) {
            chunks.push(chunk);
        });

        // header is the tar header
        // stream is the content body (might be an empty stream)
        // call next when you are done with this entry

        stream.on('end', async function() {
            const filePath = normalizeFilePath(header.name);

            const content = Buffer.concat(chunks);

            if (filePath === '!!!meta.json') {
                metaFile = JSON.parse(content.toString("UTF-8"));
            }
            else if (header.type === 'directory') {
                await saveDirectory(filePath);
            }
            else if (header.type === 'file') {
                await saveNote(filePath, content);
            }
            else {
                log.info("Ignoring tar import entry with type " + header.type);
            }

            importContext.increaseProgressCount();

            next(); // ready for next entry
        });

        stream.resume(); // just auto drain the stream
    });

    return new Promise(resolve => {
        extract.on('finish', async function() {
            const createdNoteIds = {};

            for (const path in createdPaths) {
                const noteId = createdPaths[path];

                createdNoteIds[noteId] = true;

                await noteService.scanForLinks(noteId);

                importContext.increaseProgressCount();
            }

            // we're saving attributes and links only now so that all relation and link target notes
            // are already in the database (we don't want to have "broken" relations, not even transitionally)
            for (const attr of attributes) {
                if (attr.type !== 'relation' || attr.value in createdNoteIds) {
                    await new Attribute(attr).save();
                }
                else {
                    log.info("Relation not imported since target note doesn't exist: " + JSON.stringify(attr));
                }
            }

            resolve(firstNote);
        });

        const bufferStream = new stream.PassThrough();
        bufferStream.end(fileBuffer);

        bufferStream.pipe(extract);
    });
}

module.exports = {
    importTar
};