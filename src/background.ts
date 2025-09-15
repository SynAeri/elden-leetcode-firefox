import type { Actions } from './content';

// Firefox uses the browser namespace instead of chrome
const browser = (typeof chrome !== 'undefined') ? chrome : this.browser;

interface WebRequestDetails {
    url: string;
    method: string;
    tabId: number;
    requestBody?: {
        raw?: Array<{ bytes?: Uint8Array }>;
        formData?: { [key: string]: string[] };
    };
    responseHeaders?: Array<{name: string, value?: string}>;
}

const pendingSubmissions = new Map<number, { 
    timestamp: number, 
    submissionId?: string, 
    retryCount?: number,
    hasDispatched?: boolean 
}>();

async function dispatch(action: Actions, details: WebRequestDetails): Promise<void> {
    const tabId = details.tabId;
    if (typeof tabId !== 'number' || !tabId) return;

    console.log(`Dispatching action: ${action} to tab: ${tabId}`);
    
    try {
        // Firefox tabs.get returns a promise
        let tab;
        try {
            tab = await browser.tabs.get(tabId);
        } catch (error) {
            console.error('Error getting tab:', error);
            return;
        }

        if (!tab || !tab.active) {
            console.log(`Tab ${tabId} is not active or no longer exists`);
            return;
        }

        const sendMessage = (retryCount = 0) => {
            try {
                browser.tabs.sendMessage(tabId, { action }).then((response) => {
                    if (response) {
                        console.log('Received response:', response);
                    }
                }).catch((error) => {
                    console.error('Error sending message:', error);
                    
                    if (retryCount < 2) { 
                        const delay = Math.pow(2, retryCount) * 1000;
                        console.log(`Retrying in ${delay}ms... (attempt ${retryCount + 1}/2)`);
                        setTimeout(() => sendMessage(retryCount + 1), delay);
                    } else {
                        console.error('Max retries reached for tab', tabId);
                        injectContentScript(tabId, action);
                    }
                });
            } catch (error) {
                console.error('Error in dispatch:', error);
            }
        };
        
        sendMessage(0);
    } catch (error) {
        console.error('Error in dispatch:', error);
    }
}

async function injectContentScript(tabId: number, action: Actions) {
    try {
        // Firefox uses executeScript differently
        await browser.tabs.executeScript(tabId, {
            file: 'content.js'
        });
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        browser.tabs.sendMessage(tabId, { action }).catch((error) => {
            console.error('Still failed to send message after injection:', error);
        });
    } catch (error) {
        console.error('Error injecting content script:', error);
        
        try {
            await browser.tabs.executeScript(tabId, {
                code: 'console.log("Content script injected via fallback");'
            });
            
            browser.tabs.sendMessage(tabId, { action }).catch((error) => {
                console.error('Still failed after fallback injection:', error);
            });
        } catch (fallbackError) {
            console.error('Fallback injection also failed:', fallbackError);
        }
    }
}

function readBody(detail: WebRequestDetails): any {
    if (detail.method !== 'POST') return null;

    if (detail.requestBody?.formData) {
        return detail.requestBody.formData;
    }

    const bytes = detail.requestBody?.raw?.[0]?.bytes;
    if (!bytes) return null;

    const decoder = new TextDecoder('utf-8');
    const jsonStr = decoder.decode(bytes);

    try {
        return JSON.parse(jsonStr);
    } catch {
        return jsonStr;
    }
}

const matchLeetCodeGraphQL = (detail: WebRequestDetails, operationName: string): boolean => {
    if (detail.url !== 'https://leetcode.com/graphql') return false;
    if (detail.method !== 'POST') return false;

    const body = readBody(detail);
    
    if (body && typeof body === 'object' && 'query' in body) {
        const query = Array.isArray(body.query) ? body.query[0] : body.query;
        return typeof query === 'string' && query.includes(operationName);
    }
    
    if (body && typeof body === 'object' && 'operationName' in body) {
        return body.operationName === operationName;
    }

    return false;
};

async function fetchSubmissionResult(submissionId: string, tabId: number): Promise<void> {
    try {
        const url = `https://leetcode.com/submissions/detail/${submissionId}/check/`;
        console.log(`Polling submission result from: ${url}`);
        
        const response = await fetch(url, {
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; LeetCode Extension)' }
        });
        
        if (!response.ok) {
            console.error(`Failed to fetch submission result: ${response.status}`);
            return;
        }
        
        const data = await response.json();
        console.log('Submission result data:', data);
        
        const status = data.state; 
        const statusDisplay = data.status_display || '';
        const statusCode = data.status_code;

        let action: Actions | null = null;
        
        if (status === 'SUCCESS' && (statusCode === 10 || statusDisplay === 'Accepted')) {
            action = 'submissionAccepted';
        } else if (status === 'SUCCESS') {
            action = 'submissionRejected';
        } else {
            console.log('Submission still pending, state:', status, 'display:', statusDisplay);
            
            const pending = pendingSubmissions.get(tabId);
            if (pending) {
                const retryCount = (pending.retryCount || 0) + 1;
                if (retryCount < 15) { 
                    pending.retryCount = retryCount;
                    pendingSubmissions.set(tabId, pending);
                    
                    const delay = Math.min(retryCount * 1000, 5000); 
                    setTimeout(() => fetchSubmissionResult(submissionId, tabId), delay);
                } else {
                    console.log('Max retries reached for submission check.');
                    pendingSubmissions.delete(tabId);
                }
            }
            return; 
        }

        if (action) {
            console.log(`Determined final action: ${action} for state: ${status}`);
            dispatch(action, { url: '', method: 'POST', tabId });
            pendingSubmissions.delete(tabId);
        }
        
    } catch (error) {
        console.error('Error fetching submission result:', error);
        const pending = pendingSubmissions.get(tabId);
        if (pending) {
            const retryCount = (pending.retryCount || 0) + 1;
            if (retryCount < 3) {
                 pending.retryCount = retryCount;
                 pendingSubmissions.set(tabId, pending);
                 setTimeout(() => fetchSubmissionResult(submissionId, tabId), 3000);
            } else {
                 pendingSubmissions.delete(tabId);
            }
        }
    }
}

function extractSubmissionId(url: string): string | null {
    const match = url.match(/\/submissions\/detail\/(\d+)\/check\//);
    return match ? match[1] : null;
}

browser.webRequest.onBeforeRequest.addListener(
    (detail: WebRequestDetails) => {
        console.log('Request intercepted:', detail.url, detail.method);
        
        if (detail.url === 'https://leetcode.com/graphql') {
            const body = readBody(detail);
            console.log('GraphQL request body:', body);
            
            if (matchLeetCodeGraphQL(detail, 'submitCode')) {
                console.log('Submission detected!');
                pendingSubmissions.set(detail.tabId, { timestamp: Date.now(), retryCount: 0 });
                return;
            }
        }
        
        if (detail.url.includes('leetcode.com') && detail.url.includes('submit') && 
            detail.method === 'POST' && !detail.url.includes('/check/')) {
            console.log('Direct submission URL detected:', detail.url);
            pendingSubmissions.set(detail.tabId, { timestamp: Date.now(), retryCount: 0, hasDispatched: false });
            return;
        }
    },
    { urls: ['https://leetcode.com/*'] },
    ['requestBody']
);

browser.webRequest.onCompleted.addListener(
    (detail: WebRequestDetails) => {
        console.log('Request completed:', detail.url);
        
        if (detail.url.includes('leetcode.com/submissions/detail/') && detail.url.includes('/check/')) {
            const submissionId = extractSubmissionId(detail.url);
            if (submissionId && pendingSubmissions.has(detail.tabId)) {
                console.log(`Submission status check completed for ID: ${submissionId}`);
                
                const pending = pendingSubmissions.get(detail.tabId);
                if (pending) {
                    pending.submissionId = submissionId;
                    pendingSubmissions.set(detail.tabId, pending);
                }
                
                setTimeout(() => {
                    fetchSubmissionResult(submissionId, detail.tabId);
                }, 1000);
            }
        }
    },
    { urls: ['https://leetcode.com/*'] },
    ['responseHeaders']
);

// Firefox might not have onBeforeResponse, so we add a check
if (browser.webRequest.onBeforeResponse) {
    browser.webRequest.onBeforeResponse.addListener(
        (detail: WebRequestDetails) => {
            if (detail.url.includes('leetcode.com/submissions/detail/') && detail.url.includes('/check/')) {
                const submissionId = extractSubmissionId(detail.url);
                if (submissionId && pendingSubmissions.has(detail.tabId)) {
                    console.log(`Got response for submission check: ${submissionId}`);
                    
                    setTimeout(() => {
                        browser.tabs.executeScript(detail.tabId, {
                            code: `
                                ({
                                    url: window.location.href,
                                    body: document.body.textContent
                                })
                            `
                        }).then((results) => {
                            if (results && results[0]) {
                                console.log('Page content:', results[0]);
                            }
                        }).catch(console.error);
                    }, 500);
                }
            }
        },
        { urls: ['https://leetcode.com/*'] },
        ['responseHeaders']
    );
}

setInterval(() => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    for (const [tabId, submission] of pendingSubmissions.entries()) {
        if (submission.timestamp < fiveMinutesAgo) {
            pendingSubmissions.delete(tabId);
        }
    }
}, 60000);
