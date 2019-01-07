/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2015-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/* global uDom */

'use strict';

/******************************************************************************/

(function() {

/******************************************************************************/

const messaging = vAPI.messaging;
const logger = self.logger = { ownerId: Date.now() };
const logDate = new Date();
const logDateTimezoneOffset = logDate.getTimezoneOffset() * 60000;

let loggerEntries = [];
let filteredLoggerEntries = [];
let filteredLoggerEntryVoidedCount = 0;

let popupLoggerBox;
let popupLoggerTooltips;
let activeTabId = 0;
let selectedTabId = 0;
let netInspectorPaused = false;

/******************************************************************************/

const removeAllChildren = logger.removeAllChildren = function(node) {
    while ( node.firstChild ) {
        node.removeChild(node.firstChild);
    }
};

/******************************************************************************/

const tabIdFromClassName = function(className) {
    const matches = className.match(/\btab_([^ ]+)\b/);
    if ( matches === null ) { return 0; }
    if ( matches[1] === 'bts' ) { return -1; }
    return parseInt(matches[1], 10);
};

const tabIdFromPageSelector = logger.tabIdFromPageSelector = function() {
    const value = uDom.nodeFromId('pageSelector').value;
    return value !== '_' ? (parseInt(value, 10) || 0) : activeTabId;
};

/******************************************************************************/
/******************************************************************************/

const reRFC3986 = /^([^:\/?#]+:)?(\/\/[^\/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?/;
const netFilteringDialog = uDom.nodeFromId('netFilteringDialog');

const prettyRequestTypes = {
    'main_frame': 'doc',
    'stylesheet': 'css',
    'sub_frame': 'frame',
    'xmlhttprequest': 'xhr'
};

const uglyRequestTypes = {
    'doc': 'main_frame',
    'css': 'stylesheet',
    'frame': 'sub_frame',
    'xhr': 'xmlhttprequest'
};

const staticFilterTypes = {
    'beacon': 'other',
    'doc': 'document',
    'css': 'stylesheet',
    'frame': 'subdocument',
    'ping': 'other',
    'object_subrequest': 'object',
    'xhr': 'xmlhttprequest'
};

let maxEntries = 5000;
let allTabIds = new Map();
let allTabIdsToken;

/******************************************************************************/
/******************************************************************************/

const regexFromURLFilteringResult = function(result) {
    const beg = result.indexOf(' ');
    const end = result.indexOf(' ', beg + 1);
    const url = result.slice(beg + 1, end);
    if ( url === '*' ) {
        return new RegExp('^.*$', 'gi');
    }
    return new RegExp('^' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
};

/******************************************************************************/

// Emphasize hostname in URL, as this is what matters in uMatrix's rules.

const nodeFromURL = function(url, re) {
    if ( re instanceof RegExp === false ) {
        return document.createTextNode(url);
    }
    const matches = re.exec(url);
    if ( matches === null || matches[0].length === 0 ) {
        return document.createTextNode(url);
    }
    const node = renderedURLTemplate.cloneNode(true);
    node.childNodes[0].textContent = url.slice(0, matches.index);
    node.childNodes[1].textContent = url.slice(matches.index, re.lastIndex);
    node.childNodes[2].textContent = url.slice(re.lastIndex);
    return node;
};

const renderedURLTemplate = document.querySelector('#renderedURLTemplate > span');

/******************************************************************************/

const padTo2 = function(v) {
    return v < 10 ? '0' + v : v;
};

const normalizeToStr = function(s) {
    return typeof s === 'string' && s !== '' ? s : '';
};

/******************************************************************************/

const createLogSeparator = function(details, text) {
    const separator = parseLogEntry({
        tstamp: details.tstamp,
        realm: 'message',
        tabId: details.tabId,
        type: 'separator',
        textContent: '',
    });

    const textContent = [];
    logDate.setTime(separator.tstamp - logDateTimezoneOffset);
    textContent.push(
        // cell 0
        padTo2(logDate.getUTCHours()) + ':' +
            padTo2(logDate.getUTCMinutes()) + ':' +
            padTo2(logDate.getSeconds()),
        // cell 1
        text
    );
    separator.textContent = textContent.join('\t');

    if ( details.voided !== undefined ) {
        separator.voided = true;
    }

    return separator;
};

/******************************************************************************/

const renderLogEntries = function(response) {
    const entries = response.entries;
    if ( entries.length === 0 ) { return; }

    const autoDeleteVoidedRows = uDom.nodeFromId('pageSelector').value === '_';
    const previousCount = filteredLoggerEntries.length;

    for ( const entry of entries ) {
        let unboxed = JSON.parse(entry);
        let parsed = parseLogEntry(unboxed);
        if (
            parsed.tabId !== undefined &&
            allTabIds.has(parsed.tabId) === false
        ) {
            if ( autoDeleteVoidedRows ) { continue; }
            parsed.voided = true;
        }
        if ( parsed.type === 'main_frame' && parsed.voided === undefined ) {
            const separator = createLogSeparator(parsed, unboxed.url);
            loggerEntries.unshift(separator);
            if ( rowFilterer.filterOne(separator) ) {
                filteredLoggerEntries.unshift(separator);
                if ( separator.voided !== undefined ) {
                    filteredLoggerEntryVoidedCount += 1;
                }
            }
        }
        loggerEntries.unshift(parsed);
        if ( rowFilterer.filterOne(parsed) ) {
            filteredLoggerEntries.unshift(parsed);
            if ( parsed.voided !== undefined ) {
                filteredLoggerEntryVoidedCount += 1;
            }
        }
    }

    // TODO: fix
    // Prevent logger from growing infinitely and eating all memory. For
    // instance someone could forget that it is left opened for some
    // dynamically refreshed pages.
    //truncateLog(maxEntries);

    const addedCount = filteredLoggerEntries.length - previousCount;
    if ( addedCount !== 0 ) {
        viewPort.updateContent(addedCount);
    }
};

/******************************************************************************/

const parseLogEntry = function(details) {
    const toImport = [
        'docDomain',
        'docHostname',
        'domain',
        'filter',
        'realm',
        'tabId',
        'tstamp',
        'type',
        'tabDomain',
        'tabHostname',
    ];
    const entry = {
        textContent: '',
    };
    for ( const prop of toImport ) {
        if ( details[prop] === undefined ) { continue; }
        entry[prop] = details[prop];
    }

    // Assemble the text content, i.e. the pre-built string which will be
    // used to match logger output filtering expressions.
    const textContent = [];

    // Cell 0
    logDate.setTime(details.tstamp - logDateTimezoneOffset);
    textContent.push(
        padTo2(logDate.getUTCHours()) + ':' +
        padTo2(logDate.getUTCMinutes()) + ':' +
        padTo2(logDate.getSeconds())
    );

    // Cell 1
    if ( details.realm === 'message' ) {
        textContent.push(details.text);
        entry.textContent = textContent.join('\t');
        return entry;
    }

    // Cell 1, 2
    if ( entry.filter !== undefined ) {
        textContent.push(entry.filter.raw);
        if ( entry.filter.result === 1 ) {
            textContent.push('--');
        } else if ( entry.filter.result === 2 ) {
            textContent.push('++');
        } else if ( entry.filter.result === 3 ) {
            textContent.push('**');
        } else if ( entry.filter.source === 'redirect' ) {
            textContent.push('<<');
        } else {
            textContent.push('');
        }
    } else {
        textContent.push('', '');
    }

    // Cell 3
    textContent.push(normalizeToStr(entry.docHostname));

    // Cell 4
    if (
        entry.realm === 'network' &&
        typeof entry.domain === 'string' &&
        entry.domain !== ''
    ) {
        let partyness = '';
        if ( entry.tabDomain !== undefined ) {
            partyness += entry.domain === entry.tabDomain ? '1' : '3';
        } else {
            partyness += '?';
        }
        if ( entry.docDomain !== entry.tabDomain ) {
            partyness += ',';
            if ( entry.docDomain !== undefined ) {
                partyness += entry.domain === entry.docDomain ? '1' : '3';
            } else {
                partyness += '?';
            }
        }
        textContent.push(partyness);
    } else {
        textContent.push('');
    }

    // Cell 5
    textContent.push(normalizeToStr(prettyRequestTypes[entry.type] || entry.type));

    // Cell 6
    textContent.push(normalizeToStr(details.url));

    entry.textContent = textContent.join('\t');
    return entry;
};

/******************************************************************************/

const viewPort = (function() {
    const vwRenderer = document.getElementById('vwRenderer');
    const vwScroller = document.getElementById('vwScroller');
    const vwVirtualContent = document.getElementById('vwVirtualContent');
    const vwContent = document.getElementById('vwContent');
    const vwLineSizer = document.getElementById('vwLineSizer');
    const vwLogEntryTemplate = document.querySelector('#logEntryTemplate > div');
    const vwEntries = [];

    let vwHeight = 0;
    let lineHeight = 0;
    let wholeHeight = 0;
    let lastTopPix = 0;
    let lastTopRow = 0;
    let scrollTimer;
    let resizeTimer;

    const ViewEntry = function() {
        this.div = document.createElement('div');
        this.div.className = 'logEntry';
        vwContent.appendChild(this.div);
        this.logEntry = undefined;
    };
    ViewEntry.prototype = {
        dispose: function() {
            vwContent.removeChild(this.div);
        },
    };

    const rowFromScrollTopPix = function(px) {
        return lineHeight !== 0 ? Math.floor(px / lineHeight) : 0;
    };

    // This is called when the browser fired scroll events
    const onScrollChanged = function() {
        const newScrollTopPix = vwScroller.scrollTop;
        const delta = newScrollTopPix - lastTopPix;
        if ( delta === 0 ) { return; }
        lastTopPix = newScrollTopPix;
        if ( filteredLoggerEntries.length <= 2 ) { return; }
        // No entries were rolled = all entries keep their current details
        if ( rollLines(rowFromScrollTopPix(newScrollTopPix)) ) {
            fillLines();
        }
        positionLines();
        vwContent.style.top = `${lastTopPix}px`;
    };

    // Coallesce scroll events
    const onScroll = function() {
        if ( scrollTimer !== undefined ) { return; }
        scrollTimer = setTimeout(
            ( ) => {
                scrollTimer = requestAnimationFrame(( ) => {
                    scrollTimer = undefined;
                    onScrollChanged();
                });
            },
            1000/32
        );
    };

    vwScroller.addEventListener('scroll', onScroll, { passive: true });

    const onLayoutChanged = function() {
        vwHeight = vwRenderer.clientHeight;
        vwContent.style.height = `${vwScroller.clientHeight}px`;

        const vExpanded =
            uDom.nodeFromSelector('#netInspector .vCompactToggler')
                .classList
                .contains('vExpanded');

        let newLineHeight =
            vwLineSizer.querySelector('.oneLine').clientHeight;

        if ( vExpanded ) {
            newLineHeight *= 4;
        }

        const lineCount = newLineHeight !== 0
            ? Math.ceil(vwHeight / newLineHeight) + 1
            : 0;
        if ( lineCount > vwEntries.length ) {
            do {
                vwEntries.push(new ViewEntry());
            } while ( lineCount > vwEntries.length );
        } else if ( lineCount < vwEntries.length ) {
            do {
                vwEntries.pop().dispose();
            } while ( lineCount < vwEntries.length );
        }

        const cellWidths = Array.from(
            vwLineSizer.querySelectorAll('.oneLine span')
        ).map(el => el.clientWidth + 1);
        const reservedWidth =
            cellWidths[0] + cellWidths[2] + cellWidths[4] + cellWidths[5];

        const style = document.getElementById('vwRendererRuntimeStyles');
        style.textContent = [
            '#vwContent .logEntry {',
            `    height: ${newLineHeight}px;`,
            '}',
            '#vwContent .logEntry > div > span:nth-of-type(1) {',
            `    width: ${cellWidths[0]}px;`,
            '}',
            '#vwContent .logEntry > div > span:nth-of-type(2) {',
            `    width: calc(calc(100% - ${reservedWidth}px) * 0.25);`,
            '}',
            '#vwContent .logEntry > div.messageRealm > span:nth-of-type(2) {',
            `    width: calc(100% - ${cellWidths[0]}px);`,
            '}',
            '#vwContent .logEntry > div > span:nth-of-type(3) {',
            `    width: ${cellWidths[2]}px;`,
            '}',
            '#vwContent .logEntry > div > span:nth-of-type(4) {',
            `    width: calc(calc(100% - ${reservedWidth}px) * 0.25);`,
            '}',
            '#vwContent .logEntry > div > span:nth-of-type(5) {',
            `    width: ${cellWidths[4]}px;`,
            '}',
            '#vwContent .logEntry > div > span:nth-of-type(6) {',
            `    width: ${cellWidths[5]}px;`,
            '}',
            '#vwContent .logEntry > div > span:nth-of-type(7) {',
            `    width: calc(calc(100% - ${reservedWidth}px) * 0.5);`,
            '}',
            '',
        ].join('\n');

        if ( newLineHeight !== lineHeight ) {
            lineHeight = newLineHeight;
            positionLines();
            uDom.nodeFromId('netInspector')
                .classList
                .toggle('vExpanded', vExpanded);
        }

        updateContent(0);
    };

    const updateLayout = function() {
        if ( resizeTimer !== undefined ) { return; }
        resizeTimer = setTimeout(
            ( ) => {
                resizeTimer = requestAnimationFrame(( ) => {
                    resizeTimer = undefined;
                    onLayoutChanged();
                });
            },
            1000/8
        );
    };

    window.addEventListener('resize', updateLayout, { passive: true });

    updateLayout();

    const renderToDiv = function(vwEntry, i) {
        if ( i >= filteredLoggerEntries.length ) {
            vwEntry.logEntry = undefined;
            return null;
        }

        const details = filteredLoggerEntries[i];
        if ( vwEntry.logEntry === details ) {
            return vwEntry.div.firstElementChild;
        }

        vwEntry.logEntry = details;

        const cells = details.textContent.split('\t');
        const div = vwLogEntryTemplate.cloneNode(true);
        const divcl = div.classList;
        let span;


        // Realm
        if ( details.realm !== undefined ) {
            divcl.add(details.realm + 'Realm');
        }

        // Timestamp
        span = div.children[0];
        span.textContent = cells[0];

        // Tab id
        if ( details.tabId !== undefined ) {
            div.setAttribute('data-tabid', details.tabId);
            if ( details.voided !== undefined ) {
                divcl.add('voided');
            }
        }

        if ( details.realm === 'message' ) {
            if ( details.type !== undefined ) {
                div.setAttribute('data-type', details.type);
            }
            span = div.children[1];
            span.textContent = cells[1];
            return div;
        }

        // Filter
        const filter = details.filter || undefined;
        let filteringType;
        if ( filter !== undefined ) {
            if ( typeof filter.source === 'string' ) {
                filteringType = filter.source;
                divcl.add(filteringType);
            }
            if ( filteringType === 'static' ) {
                divcl.add('canLookup');
                div.setAttribute('data-filter', filter.compiled);
            } else if ( filteringType === 'cosmetic' ) {
                divcl.add('canLookup');
            }
        }
        span = div.children[1];
        span.textContent = cells[1];

        // Event
        if ( cells[2] === '--' ) {
            divcl.add('blocked');
        } else if ( cells[2] === '++' ) {
            divcl.add('allowed');
        } else if ( cells[2] === '**' ) {
            span.add('nooped');
        } else if ( cells[2] === '<<' ) {
            divcl.add('redirect');
        }
        span = div.children[2];
        span.textContent = cells[2];

        // Origin
        if ( details.tabHostname ) {
            div.setAttribute('data-tabhn', details.tabHostname);
        }
        if ( details.docHostname ) {
            div.setAttribute('data-dochn', details.docHostname);
        }
        span = div.children[3];
        span.textContent = cells[3];

        // Partyness
        span = div.children[4];
        if ( details.realm === 'network' && details.domain !== undefined ) {
            let indent = '\t';
            let text = details.tabDomain;
            if ( details.docDomain !== details.tabDomain ) {
                text += ` \u21d2\n\t${details.docDomain}`;
                indent = '\t\t';
            }
            text += ` \u21d2\n${indent}${details.domain}`;
            span.setAttribute('data-parties', text);
        }
        span.textContent = cells[4];

        // Type
        span = div.children[5];
        span.textContent = cells[5];

        // URL
        let re = null;
        if ( filteringType === 'static' ) {
            re = new RegExp(filter.regex, 'gi');
        } else if ( filteringType === 'dynamicUrl' ) {
            re = regexFromURLFilteringResult(filter.rule.join(' '));
        }
        span = div.children[6];
        span.appendChild(nodeFromURL(cells[6], re));

        return div;
    };

    // The idea is that positioning DOM elements is faster than
    // removing/inserting DOM elements.
    const positionLines = function() {
        if ( lineHeight === 0 ) { return; }
        let y = -(lastTopPix % lineHeight);
        for ( const vwEntry of vwEntries ) {
            vwEntry.div.style.top = `${y}px`;
            y += lineHeight;
        }
    };

    const rollLines = function(topRow) {
        let delta = topRow - lastTopRow;
        let deltaLength = Math.abs(delta);
        // No point rolling if no rows can be reused
        if ( deltaLength > 0 && deltaLength < vwEntries.length ) {
            if ( delta < 0 ) {      // Move bottom rows to the top
                vwEntries.unshift(...vwEntries.splice(delta));
            } else {                // Move top rows to the bottom
                vwEntries.push(...vwEntries.splice(0, delta));
            }
        }
        lastTopRow = topRow;
        return delta;
    };

    const fillLines = function() {
        let rowBeg = lastTopRow;
        for ( const vwEntry of vwEntries ) {
            const newDiv = renderToDiv(vwEntry, rowBeg);
            const container = vwEntry.div;
            const oldDiv = container.firstElementChild;
            if ( newDiv !== null ) {
                if ( oldDiv === null ) {
                    container.appendChild(newDiv);
                } else if ( newDiv !== oldDiv ) {
                    container.removeChild(oldDiv);
                    container.appendChild(newDiv);
                }
            } else if ( oldDiv !== null ) {
                container.removeChild(oldDiv);
            }
            rowBeg += 1;
        }
    };

    const contentChanged = function(addedCount) {
        lastTopRow += addedCount;
        const newWholeHeight = Math.max(
            filteredLoggerEntries.length * lineHeight,
            vwRenderer.clientHeight
        );
        if ( newWholeHeight !== wholeHeight ) {
            vwVirtualContent.style.height = `${newWholeHeight}px`;
            wholeHeight = newWholeHeight;
        }
    };

    const updateContent = function(addedCount) {
        contentChanged(addedCount);
        // Content changed
        if ( addedCount === 0 ) {
            if (
                lastTopRow !== 0 &&
                lastTopRow + vwEntries.length > filteredLoggerEntries.length
            ) {
                lastTopRow = filteredLoggerEntries.length - vwEntries.length;
                if ( lastTopRow < 0 ) { lastTopRow = 0; }
                lastTopPix = lastTopRow * lineHeight;
                vwContent.style.top = `${lastTopPix}px`;
                vwScroller.scrollTop = lastTopPix;
                positionLines();
            }
            fillLines();
            return;
        }

        // Content added
        // Preserve scroll position
        if ( lastTopPix === 0 ) {
            rollLines(0);
            positionLines();
            fillLines();
            return;
        }

        // Preserve row position
        lastTopPix += lineHeight * addedCount;
        vwContent.style.top = `${lastTopPix}px`;
        vwScroller.scrollTop = lastTopPix;
    };

    return { updateContent, updateLayout, };
})();

/******************************************************************************/

let updateCurrentTabTitle = (function() {
    const i18nCurrentTab = vAPI.i18n('loggerCurrentTab');

    return function() {
        const select = uDom.nodeFromId('pageSelector');
        if ( select.value !== '_' || activeTabId === 0 ) { return; }
        const opt0 = select.querySelector('[value="_"]');
        const opt1 = select.querySelector('[value="' + activeTabId + '"]');
        let text = i18nCurrentTab;
        if ( opt1 !== null ) {
            text += ' / ' + opt1.textContent;
        }
        opt0.textContent = text;
    };
})();

/******************************************************************************/

const synchronizeTabIds = function(newTabIds) {
    const select = uDom.nodeFromId('pageSelector');
    const selectedTabValue = select.value;
    const oldTabIds = allTabIds;

    // Collate removed tab ids.
    const toVoid = new Set();
    for ( const tabId of oldTabIds.keys() ) {
        if ( newTabIds.has(tabId) ) { continue; }
        toVoid.add(tabId);
    }
    allTabIds = newTabIds;

    // Mark as "void" all logger entries which are linked to now invalid
    // tab ids.
    // When an entry is voided without being removed, we re-create a new entry
    // in order to ensure the entry has a new identity. A new identify ensures
    // that identity-based associations elsewhere are automatically
    // invalidated.
    if ( toVoid.size !== 0 ) {
        const autoDeleteVoidedRows = selectedTabValue === '_';
        const toKeep = [];
        let rowVoided = false;
        for ( let entry of loggerEntries ) {
            if ( toVoid.has(entry.tabId) ) {
                rowVoided = true;
                if ( autoDeleteVoidedRows ) { continue; }
                if ( entry.voided === undefined ) {
                    entry = Object.assign({ voided: true }, entry);
                }
            }
            toKeep.push(entry);
        }
        loggerEntries = toKeep;
        if ( rowVoided ) {
            rowFilterer.filterAll();
        }
    }

    // Remove popup if it is currently bound to a removed tab.
    if ( toVoid.has(popupManager.tabId) ) {
        popupManager.toggleOff();
    }

    const tabIds = Array.from(newTabIds.keys()).sort(function(a, b) {
        return newTabIds.get(a).localeCompare(newTabIds.get(b));
    });
    let j = 3;
    for ( let i = 0; i < tabIds.length; i++ ) {
        const tabId = tabIds[i];
        if ( tabId <= 0 ) { continue; }
        if ( j === select.options.length ) {
            select.appendChild(document.createElement('option'));
        }
        const option = select.options[j];
        // Truncate too long labels.
        option.textContent = newTabIds.get(tabId).slice(0, 80);
        option.setAttribute('value', tabId);
        if ( option.value === selectedTabValue ) {
            select.selectedIndex = j;
            option.setAttribute('selected', '');
        } else {
            option.removeAttribute('selected');
        }
        j += 1;
    }
    while ( j < select.options.length ) {
        select.removeChild(select.options[j]);
    }
    if ( select.value !== selectedTabValue ) {
        select.selectedIndex = 0;
        select.value = '';
        select.options[0].setAttribute('selected', '');
        pageSelectorChanged();
    }

    updateCurrentTabTitle();
};

/******************************************************************************/

// TODO: fix
/*
const truncateLog = function(size) {
    if ( size === 0 ) {
        size = 5000;
    }
    var tbody = document.querySelector('#netInspector tbody');
    size = Math.min(size, 10000);
    var tr;
    while ( tbody.childElementCount > size ) {
        tr = tbody.lastElementChild;
        trJunkyard.push(tbody.removeChild(tr));
    }
};
*/
/******************************************************************************/

const onLogBufferRead = function(response) {
    if ( !response || response.unavailable ) { return; }

    // Disable tooltips?
    if (
        popupLoggerTooltips === undefined &&
        response.tooltips !== undefined
    ) {
        popupLoggerTooltips = response.tooltips;
        if ( popupLoggerTooltips === false ) {
            uDom('[data-i18n-title]').attr('title', '');
        }
    }

    // Tab id of currently active tab
    let activeTabIdChanged = false;
    if ( response.activeTabId ) {
        activeTabIdChanged = response.activeTabId !== activeTabId;
        activeTabId = response.activeTabId;
    }

    // This may have changed meanwhile
    if ( response.maxEntries !== maxEntries ) {
        maxEntries = response.maxEntries;
        //uDom('#maxEntries').val(maxEntries || '');
    }

    if ( Array.isArray(response.tabIds) ) {
        response.tabIds = new Map(response.tabIds);
    }

    // List of tab ids has changed
    if ( response.tabIds !== undefined ) {
        synchronizeTabIds(response.tabIds);
        allTabIdsToken = response.tabIdsToken;
    }

    if ( activeTabIdChanged ) {
        pageSelectorFromURLHash();
    }

    if ( netInspectorPaused === false ) {
        renderLogEntries(response);
    }

    // Synchronize DOM with sent logger data
    document.body.classList.toggle(
        'colorBlind',
        response.colorBlind === true
    );
    uDom.nodeFromId('clean').classList.toggle(
        'disabled',
        filteredLoggerEntryVoidedCount === 0
    );
    uDom.nodeFromId('clear').classList.toggle(
        'disabled',
        filteredLoggerEntries.length === 0
    );
};

/******************************************************************************/

const readLogBuffer = (function() {
    let timer;

    const readLogBufferNow = function() {
        if ( logger.ownerId === undefined ) { return; }

        const msg = {
            what: 'readAll',
            ownerId: logger.ownerId,
            tabIdsToken: allTabIdsToken,
        };

        // This is to detect changes in the position or size of the logger
        // popup window (if in use).
        if (
            popupLoggerBox instanceof Object &&
            (
                self.screenX !== popupLoggerBox.x ||
                self.screenY !== popupLoggerBox.y ||
                self.outerWidth !== popupLoggerBox.w ||
                self.outerHeight !== popupLoggerBox.h
            )
        ) {
            popupLoggerBox.x = self.screenX;
            popupLoggerBox.y = self.screenY;
            popupLoggerBox.w = self.outerWidth;
            popupLoggerBox.h = self.outerHeight;
            msg.popupLoggerBoxChanged = true;
        }

        vAPI.messaging.send('loggerUI', msg, response => {
            timer = undefined;
            onLogBufferRead(response);
            readLogBufferLater();
        });
    };

    const readLogBufferLater = function() {
        if ( timer !== undefined ) { return; }
        if ( logger.ownerId === undefined ) { return; }
        timer = vAPI.setTimeout(readLogBufferNow, 1200);
    };

    readLogBufferNow();

    return readLogBufferLater;
})();
 
/******************************************************************************/

const pageSelectorChanged = function() {
    const select = uDom.nodeFromId('pageSelector');
    window.location.replace('#' + select.value);
    pageSelectorFromURLHash();
};

const pageSelectorFromURLHash = (function() {
    let lastHash;
    let lastSelectedTabId;

    return function() {
        let hash = window.location.hash.slice(1);
        let match = /^([^+]+)\+(.+)$/.exec(hash);
        if ( match !== null ) {
            hash = match[1];
            activeTabId = parseInt(match[2], 10) || 0;
            window.location.hash = '#' + hash;
        }

        if ( hash !== lastHash ) {
            const select = uDom.nodeFromId('pageSelector');
            let option = select.querySelector(
                'option[value="' + hash + '"]'
            );
            if ( option === null ) {
                hash = '0';
                option = select.options[0];
            }
            select.selectedIndex = option.index;
            select.value = option.value;
            lastHash = hash;
        }

        selectedTabId = hash === '_'
            ? activeTabId
            : parseInt(hash, 10) || 0;

        if ( lastSelectedTabId === selectedTabId ) { return; }

        rowFilterer.filterAll();
        document.dispatchEvent(new Event('tabIdChanged'));
        updateCurrentTabTitle();
        uDom('.needdom').toggleClass('disabled', selectedTabId <= 0);
        uDom('.needscope').toggleClass('disabled', selectedTabId <= 0);
        uDom.nodeFromId('clean').classList.toggle(
            'disabled',
            filteredLoggerEntryVoidedCount === 0
        );
        uDom.nodeFromId('clear').classList.toggle(
            'disabled',
            filteredLoggerEntries.length === 0
        );
        lastSelectedTabId = selectedTabId;
    };
})();

/******************************************************************************/

const reloadTab = function(ev) {
    const tabId = tabIdFromPageSelector();
    if ( tabId <= 0 ) { return; }
    messaging.send('loggerUI', {
        what: 'reloadTab',
        tabId: tabId,
        bypassCache: ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)
    });
};

/******************************************************************************/

// TODO: fix
/*
const onMaxEntriesChanged = function() {
    const input = uDom.nodeFromId('maxEntries');
    try {
        maxEntries = parseInt(input.value, 10);
        if ( maxEntries === 0 || isNaN(maxEntries) ) {
            maxEntries = 1000;
        }
    } catch (e) {
        maxEntries = 1000;
    }

    maxEntries = Math.min(maxEntries, 5000);
    maxEntries = Math.max(maxEntries, 10);

    input.value = maxEntries.toString(10);

    messaging.send(
        'loggerUI',
        {
            what: 'userSettings',
            name: 'requestLogMaxEntries',
            value: maxEntries
        }
    );

    truncateLog(maxEntries);
};
*/
/******************************************************************************/
/******************************************************************************/

const netFilteringManager = (function() {
    var targetRow = null;
    var dialog = null;
    var createdStaticFilters = {};

    var targetType;
    var targetURLs = [];
    var targetFrameHostname;
    var targetPageHostname;
    var targetTabId;
    var targetDomain;
    var targetPageDomain;
    var targetFrameDomain;

    const uglyTypeFromSelector = function(pane) {
        var prettyType = selectValue('select.type.' + pane);
        if ( pane === 'static' ) {
            return staticFilterTypes[prettyType] || prettyType;
        }
        return uglyRequestTypes[prettyType] || prettyType;
    };

    const selectNode = function(selector) {
        return dialog.querySelector(selector);
    };

    const selectValue = function(selector) {
        return selectNode(selector).value || '';
    };

    const staticFilterNode = function() {
        return dialog.querySelector('div.containers > div.static textarea');
    };

    const onColorsReady = function(response) {
        document.body.classList.toggle('dirty', response.dirty);
        var colorEntries = response.colors;
        var colorEntry, node;
        for ( var url in colorEntries ) {
            if ( colorEntries.hasOwnProperty(url) === false ) {
                continue;
            }
            colorEntry = colorEntries[url];
            node = dialog.querySelector('.dynamic .entry .action[data-url="' + url + '"]');
            if ( node === null ) {
                continue;
            }
            node.classList.toggle('allow', colorEntry.r === 2);
            node.classList.toggle('noop', colorEntry.r === 3);
            node.classList.toggle('block', colorEntry.r === 1);
            node.classList.toggle('own', colorEntry.own);
        }
    };

    const colorize = function() {
        messaging.send(
            'loggerUI',
            {
                what: 'getURLFilteringData',
                context: selectValue('select.dynamic.origin'),
                urls: targetURLs,
                type: uglyTypeFromSelector('dynamic')
            },
            onColorsReady
        );
    };

    const parseStaticInputs = function() {
        var filter = '',
            options = [],
            block = selectValue('select.static.action') === '';
        if ( !block ) {
            filter = '@@';
        }
        var value = selectValue('select.static.url');
        if ( value !== '' ) {
            if ( value.slice(-1) === '/' ) {
                value += '*';
            } else if ( /[/?]/.test(value) === false ) {
                value += '^';
            }
            value = '||' + value;
        }
        filter += value;
        value = selectValue('select.static.type');
        if ( value !== '' ) {
            options.push(uglyTypeFromSelector('static'));
        }
        value = selectValue('select.static.origin');
        if ( value !== '' ) {
            if ( value === targetDomain ) {
                options.push('first-party');
            } else {
                options.push('domain=' + value);
            }
        }
        if ( block && selectValue('select.static.importance') !== '' ) {
            options.push('important');
        }
        if ( options.length ) {
            filter += '$' + options.join(',');
        }
        staticFilterNode().value = filter;
        updateWidgets();
    };

    const updateWidgets = function() {
        var value = staticFilterNode().value;
        dialog.querySelector('#createStaticFilter').classList.toggle(
            'disabled',
            createdStaticFilters.hasOwnProperty(value) || value === ''
        );
    };

    const onClick = function(ev) {
        var target = ev.target;

        // click outside the dialog proper
        if ( target.classList.contains('modalDialog') ) {
            toggleOff();
            return;
        }

        ev.stopPropagation();

        var tcl = target.classList;
        var value;

        // Select a mode
        if ( tcl.contains('header') ) {
            if ( tcl.contains('selected') ) {
                return;
            }
            uDom('.header').removeClass('selected');
            uDom('.container').removeClass('selected');
            value = target.getAttribute('data-container');
            uDom('.header.' + value).addClass('selected');
            uDom('.container.' + value).addClass('selected');
            return;
        }

        // Create static filter
        if ( target.id === 'createStaticFilter' ) {
            value = staticFilterNode().value;
            // Avoid duplicates
            if ( createdStaticFilters.hasOwnProperty(value) ) {
                return;
            }
            createdStaticFilters[value] = true;
            if ( value !== '' ) {
                var d = new Date();
                messaging.send(
                    'loggerUI',
                    {
                        what: 'createUserFilter',
                        pageDomain: targetPageDomain,
                        filters: '! ' + d.toLocaleString() + ' ' + targetPageDomain + '\n' + value
                    }
                );
            }
            updateWidgets();
            return;
        }

        // Save url filtering rule(s)
        if ( target.id === 'saveRules' ) {
                messaging.send(
                'loggerUI',
                {
                    what: 'saveURLFilteringRules',
                    context: selectValue('select.dynamic.origin'),
                    urls: targetURLs,
                    type: uglyTypeFromSelector('dynamic')
                },
                colorize
            );
            return;
        }

        var persist = !!ev.ctrlKey || !!ev.metaKey;

        // Remove url filtering rule
        if ( tcl.contains('action') ) {
            messaging.send(
                'loggerUI',
                {
                    what: 'setURLFilteringRule',
                    context: selectValue('select.dynamic.origin'),
                    url: target.getAttribute('data-url'),
                    type: uglyTypeFromSelector('dynamic'),
                    action: 0,
                    persist: persist
                },
                colorize
            );
            return;
        }

        // add "allow" url filtering rule
        if ( tcl.contains('allow') ) {
            messaging.send(
                'loggerUI',
                {
                    what: 'setURLFilteringRule',
                    context: selectValue('select.dynamic.origin'),
                    url: target.parentNode.getAttribute('data-url'),
                    type: uglyTypeFromSelector('dynamic'),
                    action: 2,
                    persist: persist
                },
                colorize
            );
            return;
        }

        // add "block" url filtering rule
        if ( tcl.contains('noop') ) {
            messaging.send(
                'loggerUI',
                {
                    what: 'setURLFilteringRule',
                    context: selectValue('select.dynamic.origin'),
                    url: target.parentNode.getAttribute('data-url'),
                    type: uglyTypeFromSelector('dynamic'),
                    action: 3,
                    persist: persist
                },
                colorize
            );
            return;
        }

        // add "block" url filtering rule
        if ( tcl.contains('block') ) {
            messaging.send(
                'loggerUI',
                {
                    what: 'setURLFilteringRule',
                    context: selectValue('select.dynamic.origin'),
                    url: target.parentNode.getAttribute('data-url'),
                    type: uglyTypeFromSelector('dynamic'),
                    action: 1,
                    persist: persist
                },
                colorize
            );
            return;
        }

        // Force a reload of the tab
        if ( tcl.contains('reload') ) {
            messaging.send(
                'loggerUI',
                {
                    what: 'reloadTab',
                    tabId: targetTabId
                }
            );
            return;
        }

        // Hightlight corresponding element in target web page
        if ( tcl.contains('picker') ) {
            messaging.send(
                'loggerUI',
                {
                    what: 'launchElementPicker',
                    tabId: targetTabId,
                    targetURL: 'img\t' + targetURLs[0],
                    select: true
                }
            );
            return;
        }
    };

    const onSelectChange = function(ev) {
        var target = ev.target;
        var tcl = target.classList;

        if ( tcl.contains('dynamic') ) {
            colorize();
            return;
        }

        if ( tcl.contains('static') ) {
            parseStaticInputs();
            return;
        }
    };

    const onInputChange = function() {
        updateWidgets();
    };

    const createPreview = function(type, url) {
        // First, whether picker can be used
        dialog.querySelector('.picker').classList.toggle(
            'hide',
            targetTabId < 0 ||
            targetType !== 'image' ||
            /(?:^| )[dlsu]b(?: |$)/.test(targetRow.className)
        );

        var preview = null;

        if ( type === 'image' ) {
            preview = document.createElement('img');
            preview.setAttribute('src', url);
        }

        var container = dialog.querySelector('div.preview');
        container.classList.toggle('hide', preview === null);
        if ( preview === null ) {
            return;
        }
        container.appendChild(preview);
    };

    // https://github.com/gorhill/uBlock/issues/1511
    const shortenLongString = function(url, max) {
        var urlLen = url.length;
        if ( urlLen <= max ) {
            return url;
        }
        var n = urlLen - max - 1;
        var i = (urlLen - n) / 2 | 0;
        return url.slice(0, i) + '…' + url.slice(i + n);
    };

    // Build list of candidate URLs
    const createTargetURLs = function(url) {
        const urls = [];
        const matches = reRFC3986.exec(url);
        if ( matches === null || !matches[1] || !matches[2] ) {
            return urls;
        }
        // Shortest URL for a valid URL filtering rule
        const rootURL = matches[1] + matches[2];
        urls.unshift(rootURL);
        const path = matches[3] || '';
        let pos = path.charAt(0) === '/' ? 1 : 0;
        while ( pos < path.length ) {
            pos = path.indexOf('/', pos);
            if ( pos === -1 ) {
                pos = path.length;
            } else {
                pos += 1;
            }
            urls.unshift(rootURL + path.slice(0, pos));
        }
        const query = matches[4] || '';
        if ( query !== '' ) {
            urls.unshift(rootURL + path + query);
        }
        return urls;
    };

    // Fill dynamic URL filtering pane
    const fillDynamicPane = function() {
        var select;
        // Fill context selector
        select = selectNode('select.dynamic.origin');
        removeAllChildren(select);
        fillOriginSelect(select, targetPageHostname, targetPageDomain);
        var option = document.createElement('option');
        option.textContent = '*';
        option.setAttribute('value', '*');
        select.appendChild(option);

        // Fill type selector
        select = selectNode('select.dynamic.type');
        select.options[0].textContent = targetType;
        select.options[0].setAttribute('value', targetType);
        select.selectedIndex = 0;

        // Fill entries
        var menuEntryTemplate = dialog.querySelector('table.toolbar tr.entry');
        var tbody = dialog.querySelector('div.dynamic table.entries tbody');
        var url, menuEntry;
        for ( var i = 0; i < targetURLs.length; i++ ) {
            url = targetURLs[i];
            menuEntry = menuEntryTemplate.cloneNode(true);
            menuEntry.cells[0].children[0].setAttribute('data-url', url);
            menuEntry.cells[1].textContent = shortenLongString(url, 128);
            tbody.appendChild(menuEntry);
        }

        colorize();
    };

    const fillOriginSelect = function(select, hostname, domain) {
        var option, pos;
        var template = vAPI.i18n('loggerStaticFilteringSentencePartOrigin');
        var value = hostname;
        for (;;) {
            option = document.createElement('option');
            option.setAttribute('value', value);
            option.textContent = template.replace('{{origin}}', value);
            select.appendChild(option);
            if ( value === domain ) {
                break;
            }
            pos = value.indexOf('.');
            if ( pos === -1 ) {
                break;
            }
            value = value.slice(pos + 1);
        }
    };

    // Fill static filtering pane
    const fillStaticPane = function() {
        var template = vAPI.i18n('loggerStaticFilteringSentence');
        var rePlaceholder = /\{\{[^}]+?\}\}/g;
        var nodes = [];
        var match, pos = 0;
        var select, option, n, i, value;
        for (;;) {
            match = rePlaceholder.exec(template);
            if ( match === null ) {
                break;
            }
            if ( pos !== match.index ) {
                nodes.push(document.createTextNode(template.slice(pos, match.index)));
            }
            pos = rePlaceholder.lastIndex;
            switch ( match[0] ) {
            case '{{br}}':
                nodes.push(document.createElement('br'));
                break;

            case '{{action}}':
                select = document.createElement('select');
                select.className = 'static action';
                option = document.createElement('option');
                option.setAttribute('value', '');
                option.textContent = vAPI.i18n('loggerStaticFilteringSentencePartBlock');
                select.appendChild(option);
                option = document.createElement('option');
                option.setAttribute('value', '@@');
                option.textContent = vAPI.i18n('loggerStaticFilteringSentencePartAllow');
                select.appendChild(option);
                nodes.push(select);
                break;

            case '{{type}}':
                select = document.createElement('select');
                select.className = 'static type';
                option = document.createElement('option');
                option.setAttribute('value', targetType);
                option.textContent = vAPI.i18n('loggerStaticFilteringSentencePartType').replace('{{type}}', targetType);
                select.appendChild(option);
                option = document.createElement('option');
                option.setAttribute('value', '');
                option.textContent = vAPI.i18n('loggerStaticFilteringSentencePartAnyType');
                select.appendChild(option);
                nodes.push(select);
                break;

            case '{{url}}':
                select = document.createElement('select');
                select.className = 'static url';
                for ( i = 0, n = targetURLs.length; i < n; i++ ) {
                    value = targetURLs[i].replace(/^[a-z-]+:\/\//, '');
                    option = document.createElement('option');
                    option.setAttribute('value', value);
                    option.textContent = shortenLongString(value, 128);
                    select.appendChild(option);
                }
                nodes.push(select);
                break;

            case '{{origin}}':
                select = document.createElement('select');
                select.className = 'static origin';
                fillOriginSelect(select, targetFrameHostname, targetFrameDomain);
                option = document.createElement('option');
                option.setAttribute('value', '');
                option.textContent = vAPI.i18n('loggerStaticFilteringSentencePartAnyOrigin');
                select.appendChild(option);
                nodes.push(select);
                break;

            case '{{importance}}':
                select = document.createElement('select');
                select.className = 'static importance';
                option = document.createElement('option');
                option.setAttribute('value', '');
                option.textContent = vAPI.i18n('loggerStaticFilteringSentencePartNotImportant');
                select.appendChild(option);
                option = document.createElement('option');
                option.setAttribute('value', 'important');
                option.textContent = vAPI.i18n('loggerStaticFilteringSentencePartImportant');
                select.appendChild(option);
                nodes.push(select);
                break;

            default:
                break;
            }
        }
        if ( pos < template.length ) {
            nodes.push(document.createTextNode(template.slice(pos)));
        }
        var parent = dialog.querySelector('div.containers > div.static > p:first-of-type');
        removeAllChildren(parent);
        for ( i = 0; i < nodes.length; i++ ) {
            parent.appendChild(nodes[i]);
        }
        parseStaticInputs();
    };

    const fillDialog = function(domains) {
        targetDomain = domains[0];
        targetPageDomain = domains[1];
        targetFrameDomain = domains[2];

        createPreview(targetType, targetURLs[0]);
        fillDynamicPane();
        fillStaticPane();
        document.body.appendChild(netFilteringDialog);
        netFilteringDialog.addEventListener('click', onClick, true);
        netFilteringDialog.addEventListener('change', onSelectChange, true);
        netFilteringDialog.addEventListener('input', onInputChange, true);
    };

    const toggleOn = function(ev) {
        dialog = netFilteringDialog.querySelector('.dialog');
        targetRow = ev.target.closest('.networkRealm');
        targetTabId = tabIdFromClassName(targetRow.className);
        targetType = targetRow.children[5].textContent.trim() || '';
        targetURLs = createTargetURLs(targetRow.children[6].textContent);
        targetPageHostname = targetRow.getAttribute('data-tabhn') || '';
        targetFrameHostname = targetRow.getAttribute('data-dochn') || '';

        // We need the root domain names for best user experience.
        messaging.send(
            'loggerUI',
            {
                what: 'getDomainNames',
                targets: [targetURLs[0], targetPageHostname, targetFrameHostname]
            },
            fillDialog
        );
    };

    const toggleOff = function() {
        removeAllChildren(dialog.querySelector('div.preview'));
        removeAllChildren(dialog.querySelector('div.dynamic table.entries tbody'));
        dialog = null;
        targetRow = null;
        targetURLs = [];
        netFilteringDialog.removeEventListener('click', onClick, true);
        netFilteringDialog.removeEventListener('change', onSelectChange, true);
        netFilteringDialog.removeEventListener('input', onInputChange, true);
        document.body.removeChild(netFilteringDialog);
    };

    return { toggleOn };
})();

// https://www.youtube.com/watch?v=XyNYrmmdUd4

/******************************************************************************/
/******************************************************************************/

const reverseLookupManager = (function() {
    const filterFinderDialog = uDom.nodeFromId('filterFinderDialog');
    let rawFilter = '';

    const removeAllChildren = function(node) {
        while ( node.firstChild ) {
            node.removeChild(node.firstChild);
        }
    };

    // Clicking outside the dialog will close the dialog
    const onClick = function(ev) {
        if ( ev.target.classList.contains('modalDialog') ) {
            toggleOff();
            return;
        }

        ev.stopPropagation();
    };

    const nodeFromFilter = function(filter, lists) {
        if ( Array.isArray(lists) === false || lists.length === 0 ) { return; }

        const p = document.createElement('p');

        vAPI.i18n.safeTemplateToDOM(
            'loggerStaticFilteringFinderSentence1',
            { filter: filter },
            p
        );

        const ul = document.createElement('ul');
        for ( const list of lists ) {
            const li = document.querySelector('#filterFinderListEntry > li')
                               .cloneNode(true);
            let a = li.querySelector('a:nth-of-type(1)');
            a.href += encodeURIComponent(list.assetKey);
            a.textContent = list.title;
            if ( list.supportURL ) {
                a = li.querySelector('a:nth-of-type(2)');
                a.setAttribute('href', list.supportURL);
            }
            ul.appendChild(li);
        }
        p.appendChild(ul);

        return p;
    };

    const reverseLookupDone = function(response) {
        if ( response instanceof Object === false ) {
            response = {};
        }

        const dialog = filterFinderDialog.querySelector('.dialog');
        removeAllChildren(dialog);

        for ( const filter in response ) {
            let p = nodeFromFilter(filter, response[filter]);
            if ( p === undefined ) { continue; }
            dialog.appendChild(p);
        }

        // https://github.com/gorhill/uBlock/issues/2179
        if ( dialog.childElementCount === 0 ) {
            vAPI.i18n.safeTemplateToDOM(
                'loggerStaticFilteringFinderSentence2',
                { filter: rawFilter },
                dialog
            );
        }

        document.body.appendChild(filterFinderDialog);
        filterFinderDialog.addEventListener('click', onClick, true);
    };

    const toggleOn = function(ev) {
        const row = ev.target.closest('.canLookup');
        if ( row === null ) { return; }
        rawFilter = row.children[1].textContent;
        if ( rawFilter === '' ) { return; }
        if ( row.classList.contains('networkRealm') ) {
            messaging.send(
                'loggerUI',
                {
                    what: 'listsFromNetFilter',
                    compiledFilter: row.getAttribute('data-filter') || '',
                    rawFilter: rawFilter
                },
                reverseLookupDone
            );
        } else if ( row.classList.contains('cosmeticRealm') ) {
            messaging.send(
                'loggerUI',
                {
                    what: 'listsFromCosmeticFilter',
                    url: row.children[6].textContent,
                    rawFilter: rawFilter,
                },
                reverseLookupDone
            );
        }
    };

    const toggleOff = function() {
        filterFinderDialog.removeEventListener('click', onClick, true);
        document.body.removeChild(filterFinderDialog);
        rawFilter = '';
    };

    return {
        toggleOn: toggleOn
    };
})();

/******************************************************************************/
/******************************************************************************/

const rowFilterer = (function() {
    const userFilters = [];
    const builtinFilters = [];

    let masterFilterSwitch = true;
    let filters = [];

    const parseInput = function() {
        userFilters.length = 0;

        const rawParts =
            uDom.nodeFromSelector('#filterInput > input')
                .value
                .trim()
                .split(/\s+/);
        const n = rawParts.length;
        const reStrs = [];
        let not = false;
        for ( let i = 0; i < n; i++ ) {
            let rawPart = rawParts[i];
            if ( rawPart.charAt(0) === '!' ) {
                if ( reStrs.length === 0 ) {
                    not = true;
                }
                rawPart = rawPart.slice(1);
            }
            let reStr = '';
            if ( rawPart.startsWith('/') && rawPart.endsWith('/') ) {
                reStr = rawPart.slice(1, -1);
                try {
                    new RegExp(reStr);
                } catch(ex) {
                    reStr = '';
                }
            }
            if ( reStr === '' ) {
                const hardBeg = rawPart.startsWith('|');
                if ( hardBeg ) {
                    rawPart = rawPart.slice(1);
                }
                const hardEnd = rawPart.endsWith('|');
                if ( hardEnd ) {
                    rawPart = rawPart.slice(0, -1);
                }
                // https://developer.mozilla.org/en/docs/Web/JavaScript/Guide/Regular_Expressions
                reStr = rawPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // https://github.com/orgs/uBlockOrigin/teams/ublock-issues-volunteers/discussions/51
                //   Be more flexible when interpreting leading/trailing pipes,
                //   as leading/trailing pipes are often used in static filters.
                if ( hardBeg ) {
                    reStr = reStr !== '' ? '(?:^|\\s|\\|)' + reStr : '\\|';
                }
                if ( hardEnd ) {
                    reStr += '(?:\\||\\s|$)';
                }
            }
            if ( reStr === '' ) { continue; }
            reStrs.push(reStr);
            if ( i < (n - 1) && rawParts[i + 1] === '||' ) {
                i += 1;
                continue;
            }
            reStr = reStrs.length === 1 ? reStrs[0] : reStrs.join('|');
            userFilters.push({
                re: new RegExp(reStr, 'i'),
                r: !not
            });
            reStrs.length = 0;
            not = false;
        }
        filters = builtinFilters.concat(userFilters);
    };

    const filterOne = function(logEntry) {
        if (
            selectedTabId !== 0 &&
            logEntry.tabId !== undefined &&
            logEntry.tabId > 0 &&
            logEntry.tabId !== selectedTabId
        ) {
            return false;
        }

        if ( masterFilterSwitch === false || filters.length === 0 ) {
            return true;
        }

        // Do not filter out doc boundaries, they help separate key sections
        // of logger.
        if ( logEntry.type === 'separator' ) { return true; }

        for ( const f of filters ) {
            if ( f.re.test(logEntry.textContent) !== f.r ) { return false; }
        }
        return true;
    };

    const filterAll = function() {
        filteredLoggerEntries = [];
        filteredLoggerEntryVoidedCount = 0;
        for ( const entry of loggerEntries ) {
            if ( filterOne(entry) === false ) { continue; }
            filteredLoggerEntries.push(entry);
            if ( entry.voided !== undefined ) {
                filteredLoggerEntryVoidedCount += 1;
            }
        }
        viewPort.updateContent(0);
        uDom.nodeFromId('filterButton').classList.toggle(
            'active',
            filters.length !== 0
        );
    };

    const onFilterChangedAsync = (function() {
        let timer;
        const commit = ( ) => {
            timer = undefined;
            parseInput();
            filterAll();
        };
        return function() {
            if ( timer !== undefined ) {
                clearTimeout(timer);
            }
            timer = vAPI.setTimeout(commit, 750);
        };
    })();

    const onFilterButton = function() {
        masterFilterSwitch = !masterFilterSwitch;
        uDom.nodeFromId('netInspector').classList.toggle(
            'f',
            masterFilterSwitch
        );
        filterAll();            
    };

    const onToggleExtras = function(ev) {
        ev.target.classList.toggle('expanded');
    };

    const onToggleBuiltinExpression = function(ev) {
        builtinFilters.length = 0;

        ev.target.classList.toggle('on');
        const filtexElems = ev.currentTarget.querySelectorAll('[data-filtex]');
        const orExprs = [];
        let not = false;
        for ( const filtexElem of filtexElems ) {
            let filtex = filtexElem.getAttribute('data-filtex');
            let active = filtexElem.classList.contains('on');
            if ( filtex === '!' ) {
                if ( orExprs.length !== 0 ) {
                    builtinFilters.push({
                        re: new RegExp(orExprs.join('|')),
                        r: !not
                    });
                    orExprs.length = 0;
                }
                not = active;
            } else if ( active ) {
                orExprs.push(filtex);
            }
        }
        if ( orExprs.length !== 0 ) {
            builtinFilters.push({
                re: new RegExp(orExprs.join('|')),
                r: !not
            });
        }
        filters = builtinFilters.concat(userFilters);
        uDom.nodeFromId('filterExprButton').classList.toggle(
            'active',
            builtinFilters.length !== 0
        );
        filterAll();
    };

    uDom('#filterButton').on('click', onFilterButton);
    uDom('#filterInput > input').on('input', onFilterChangedAsync);
    uDom('#filterExprButton').on('click', onToggleExtras);
    uDom('#filterExprPicker').on('click', '[data-filtex]', onToggleBuiltinExpression);

    // https://github.com/gorhill/uBlock/issues/404
    //   Ensure page state is in sync with the state of its various widgets.
    parseInput();
    filterAll();

    return { filterOne, filterAll };
})();

/******************************************************************************/

// Clear the logger's visible content.
//
// "Unrelated" entries -- shown for convenience -- will be also cleared
// if and only if the filtered logger content is made entirely of unrelated
// entries. In effect, this means clicking a second time on the eraser will
// cause unrelated entries to also be cleared.

const clearBuffer = function() {
    let clearUnrelated = true;
    if ( selectedTabId !== 0 ) {
        for ( const entry of filteredLoggerEntries ) {
            if ( entry.tabId === selectedTabId ) {
                clearUnrelated = false;
                break;
            }
        }
    }

    const toRemove = new Set(filteredLoggerEntries);
    const toKeep = [];
    for ( const entry of loggerEntries ) {
        if (
            toRemove.has(entry) === false ||
            entry.tabId !== selectedTabId && clearUnrelated === false
        ) {
            toKeep.push(entry);
        }
    }
    loggerEntries = toKeep;
    rowFilterer.filterAll();

    uDom.nodeFromId('clean').classList.toggle(
        'disabled',
        filteredLoggerEntryVoidedCount === 0
    );
    uDom.nodeFromId('clear').classList.toggle(
        'disabled',
        filteredLoggerEntries.length === 0
    );
};

/******************************************************************************/

// Clear voided entries from the logger's visible content.
//
// Voided entries should be visible only from the "All" option of the
// tab selector.

const cleanBuffer = function() {
    const toRemove = new Set(filteredLoggerEntries);
    const toKeep = [];
    for ( const entry of loggerEntries ) {
        if ( entry.voided === undefined || toRemove.has(entry) === false ) {
            toKeep.push(entry);
        }
    }
    loggerEntries = toKeep;
    rowFilterer.filterAll();

    uDom.nodeFromId('clean').classList.toggle(
        'disabled',
        filteredLoggerEntryVoidedCount === 0
    );
    uDom.nodeFromId('clear').classList.toggle(
        'disabled',
        filteredLoggerEntries.length === 0
    );
};

/******************************************************************************/

const pauseNetInspector = function() {
    netInspectorPaused = uDom.nodeFromId('netInspector')
                             .classList
                             .toggle('paused');
};

/******************************************************************************/

const toggleVCompactView = function() {
    uDom.nodeFromSelector('#netInspector .vCompactToggler')
        .classList
        .toggle('vExpanded');
    viewPort.updateLayout();
};

// TODO: fix
const toggleVCompactRow = function(ev) {
    ev.target.parentElement.classList.toggle('vExpanded');
};

/******************************************************************************/

const popupManager = (function() {
    let realTabId = 0;
    let popup = null;
    let popupObserver = null;

    const resizePopup = function() {
        if ( popup === null ) { return; }
        const popupBody = popup.contentWindow.document.body;
        if ( popupBody.clientWidth !== 0 && popup.clientWidth !== popupBody.clientWidth ) {
            popup.style.setProperty('width', popupBody.clientWidth + 'px');
        }
        if ( popupBody.clientHeight !== 0 && popup.clientHeight !== popupBody.clientHeight ) {
            popup.style.setProperty('height', popupBody.clientHeight + 'px');
        }
    };

    const onLoad = function() {
        resizePopup();
        popupObserver.observe(popup.contentDocument.body, {
            subtree: true,
            attributes: true
        });
    };

    const setTabId = function(tabId) {
        if ( popup === null ) { return; }
        popup.setAttribute('src', 'popup.html?tabId=' + tabId);
    };

    const onTabIdChanged = function() {
        const tabId = tabIdFromPageSelector();
        if ( tabId === 0 ) { return toggleOff(); }
        realTabId = tabId;
        setTabId(realTabId);
    };

    const toggleOn = function() {
        const tabId = tabIdFromPageSelector();
        if ( tabId === 0 ) { return; }
        realTabId = tabId;

        popup = uDom.nodeFromId('popupContainer');

        popup.addEventListener('load', onLoad);
        popupObserver = new MutationObserver(resizePopup);

        const parent = uDom.nodeFromId('inspectors');
        const rect = parent.getBoundingClientRect();
        popup.style.setProperty('right', (rect.right - parent.clientWidth) + 'px');
        parent.classList.add('popupOn');

        document.addEventListener('tabIdChanged', onTabIdChanged);

        setTabId(realTabId);
        uDom.nodeFromId('showpopup').classList.add('active');
    };

    const toggleOff = function() {
        uDom.nodeFromId('showpopup').classList.remove('active');
        document.removeEventListener('tabIdChanged', onTabIdChanged);
        uDom.nodeFromId('inspectors').classList.remove('popupOn');
        popup.removeEventListener('load', onLoad);
        popupObserver.disconnect();
        popupObserver = null;
        popup.setAttribute('src', '');
    
        realTabId = 0;
    };

    const exports = {
        toggleOff: function() {
            if ( realTabId !== 0 ) {
                toggleOff();
            }
        }
    };

    Object.defineProperty(exports, 'tabId', {
        get: function() { return realTabId || 0; }
    });

    uDom('#showpopup').on('click', ( ) => {
        void (realTabId === 0 ? toggleOn() : toggleOff());
    });

    return exports;
})();

/******************************************************************************/

logger.resize = (function() {
    let timer;

    const resize = function() {
        const vrect = document.body.getBoundingClientRect();
        const elems = document.querySelectorAll('.vscrollable');
        for ( const elem of elems ) {
            const crect = elem.getBoundingClientRect();
            const dh = crect.bottom - vrect.bottom;
            if ( dh === 0 ) { continue; }
            elem.style.height = (crect.height - dh) + 'px';
        }
    };

    const resizeAsync = function() {
        if ( timer !== undefined ) { return; }
        timer = self.requestAnimationFrame(( ) => {
            timer = undefined;
            resize();
        });
    };

    resizeAsync();

    window.addEventListener('resize', resizeAsync, { passive: true });

    return resizeAsync;
})();

/******************************************************************************/

const grabView = function() {
    if ( logger.ownerId === undefined ) {
        logger.ownerId = Date.now();
    }
    readLogBuffer();
};

const releaseView = function() {
    if ( logger.ownerId === undefined ) { return; }
    vAPI.messaging.send(
        'loggerUI',
        { what: 'releaseView', ownerId: logger.ownerId }
    );
    logger.ownerId = undefined;
};

window.addEventListener('pagehide', releaseView);
window.addEventListener('pageshow', grabView);
// https://bugzilla.mozilla.org/show_bug.cgi?id=1398625
window.addEventListener('beforeunload', releaseView);

/******************************************************************************/

uDom('#pageSelector').on('change', pageSelectorChanged);
uDom('#refresh').on('click', reloadTab);

uDom('#netInspector .vCompactToggler').on('click', toggleVCompactView);

uDom.nodeFromId('clean').addEventListener('click', cleanBuffer);
uDom.nodeFromId('clear').addEventListener('click', clearBuffer);

uDom('#pause').on('click', pauseNetInspector);
//uDom('#maxEntries').on('change', onMaxEntriesChanged);
uDom('#netInspector table').on('click', 'tr > td:nth-of-type(1)', toggleVCompactRow);
uDom('#netInspector').on('click', '.logEntry > .canLookup > span:nth-of-type(2)', reverseLookupManager.toggleOn);
uDom('#netInspector').on('click', '.logEntry > .networkRealm > span:nth-of-type(3)', netFilteringManager.toggleOn);

// https://github.com/gorhill/uBlock/issues/507
//   Ensure tab selector is in sync with URL hash
pageSelectorFromURLHash();
window.addEventListener('hashchange', pageSelectorFromURLHash);

// Start to watch the current window geometry 2 seconds after the document
// is loaded, to be sure no spurious geometry changes will be triggered due
// to the window geometry pontentially not settling fast enough.
if ( self.location.search.includes('popup=1') ) {
    window.addEventListener('load', ( ) => {
        setTimeout(( ) => {
            popupLoggerBox = {
                x: self.screenX,
                y: self.screenY,
                w: self.outerWidth,
                h: self.outerHeight,
            };
        }, 2000);
    }, { once: true });
}

/******************************************************************************/

})();
