/**
 * Self-Loom Frontend Controller
 */

class SelfLoomApp {
    constructor() {
        this.eventSource = null;
        this.isGenerating = false;
        this.currentIteration = 0;
        this.completions = {};
        this.consecutiveEmptyCount = 0; // Track consecutive iterations with all empty completions
        
        this.statusEl = document.getElementById('status');
        this.fullTextEl = document.getElementById('fullText');
        this.fullTextContainerEl = document.querySelector('.full-text-container');
        this.iterationInfoEl = document.getElementById('iterationInfo');
        this.completionsContainerEl = document.getElementById('completionsContainer');
        this.toggleBtn = document.getElementById('toggleBtn');
        
        this.setupEventHandlers();
        this.loadTheme();
        this.setupResizer();
        this.setupDocumentManager();
        this.setupTextInput();
        this.initializeSettings();
        this.setupMobileBackdrop();
        this.updateGenerationButton();
    }
    
    setupEventHandlers() {
        window.toggleTheme = () => this.toggleTheme();
        window.toggleGeneration = () => this.toggleGeneration();
        window.toggleDocumentSidebar = () => this.toggleDocumentSidebar();
        window.newDocument = () => this.newDocument();
        window.toggleSettingsAccordion = () => this.toggleSettingsAccordion();
        
        // Setup token form handler
        const tokenForm = document.getElementById('token-form');
        if (tokenForm) {
            tokenForm.addEventListener('submit', (e) => this.handleTokenSubmit(e));
        }

        // Intercept Ctrl+S / Cmd+S to auto-save and show toast
        document.addEventListener('keydown', async (e) => {
            const isCtrlS = (e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey);
            if (!isCtrlS) return;
            e.preventDefault();
            try {
                await this.autoSaveDocument();
            } finally {
                this.showAutosaveToast();
            }
        });
    }
    
    toggleGeneration() {
        if (this.isGenerating) {
            this.stopGeneration();
        } else {
            this.startGeneration();
        }
    }
    
    showAutosaveToast() {
        const toastEl = document.getElementById('autosaveToast');
        if (!toastEl) return;
        toastEl.classList.add('show');
        clearTimeout(this._autosaveToastTimer);
        this._autosaveToastTimer = setTimeout(() => {
            toastEl.classList.remove('show');
        }, 1200);
    }

    startGeneration() {
        if (this.isGenerating) return;
        
        console.log('Starting text generation');
        this.isGenerating = true;
        this.consecutiveEmptyCount = 0; // Reset counter when starting new generation
        this.updateGenerationButton();
        this.toggleSettingsInputs(false); // Disable settings inputs
        
        // Get current text as seed and make text box read-only
        const seedText = this.fullTextEl.value || '';
        this.fullTextEl.readOnly = true;
        this.markDocumentModified();
        
        this.updateStatus('Connecting...');
        
        // Get settings from form
        const maxNewTokens = document.getElementById('max_new_tokens').value;
        const temperature = document.getElementById('temperature').value;
        const minP = document.getElementById('min_p').value;
        const baseModel = document.getElementById('base-model').value;
        const graderModel = document.getElementById('grader-model').value;
        const graderPrompt = document.getElementById('grader-prompt').value;
        
        // Save the models for next time
        this.saveModels();
        
        // Send seed text and settings to server
        const params = new URLSearchParams({
            seed: seedText,
            max_new_tokens: maxNewTokens,
            temperature: temperature,
            min_p: minP,
            base_model: baseModel,
            grader_model: graderModel,
            grader_prompt: graderPrompt
        });
        this.eventSource = new EventSource(`/generate?${params.toString()}`);
        
        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleGenerationEvent(data);
            } catch (e) {
                console.error('Failed to parse SSE data:', e);
            }
        };
        
        this.eventSource.onerror = (event) => {
            console.error('SSE connection error:', event);
            this.updateStatus('Connection error');
            this.stopGeneration();
        };
    }
    
    stopGeneration() {
        if (!this.isGenerating) return;
        
        console.log('Force stopping generation - immediate shutdown');
        
        this.isGenerating = false;
        this.updateGenerationButton();
        this.toggleSettingsInputs(true); // Re-enable settings inputs
        
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        
        this.currentIteration = 0;
        this.completions = {};
        this.consecutiveEmptyCount = 0; // Reset counter when stopping
        this.updateIterationInfo('Iteration: Stopped');
        this.updateStatus('Stopped');
        
        // Reset to editable text input but keep the generated content
        this.fullTextEl.readOnly = false;
        
        this.completionsContainerEl.innerHTML = `
            <div style="text-align: center; color: var(--text-secondary); margin-top: 50px;">
                <p>Generation stopped. Click "Start" to continue from current text.</p>
            </div>
        `;
    }
    
    updateGenerationButton() {
        const toggleBtn = document.getElementById('toggleBtn');
        if (toggleBtn) {
            if (this.isGenerating) {
                toggleBtn.textContent = 'Stop';
                toggleBtn.className = 'btn btn-stop';
            } else {
                toggleBtn.textContent = 'Start';
                toggleBtn.className = 'btn btn-start';
            }
        }
    }
    
    handleGenerationEvent(data) {
        console.log('Received event:', data.type, data);
        
        switch (data.type) {
            case 'init':
                this.handleInit(data);
                break;
            case 'iteration_start':
                this.handleIterationStart(data);
                break;
            case 'completion_start':
                this.handleCompletionStart(data);
                break;
            case 'completion_token':
                this.handleCompletionToken(data);
                break;
            case 'completion_done':
                this.handleCompletionDone(data);
                break;
            case 'grading_start':
                this.handleGradingStart(data);
                break;
            case 'grading_done':
                this.handleGradingDone(data);
                break;
            case 'text_updated':
                this.handleTextUpdated(data);
                break;
            case 'complete':
                this.handleComplete(data);
                break;
            case 'document_named':
                this.handleDocumentNamed(data);
                break;
            case 'error':
                this.handleError(data);
                break;
            default:
                console.log('Unknown event type:', data.type);
        }
    }
    
    handleInit(data) {
        this.updateStatus('Generation started with seed text');
        // Set textarea content directly (newlines preserved automatically)
        this.fullTextEl.value = data.text;
        this.scrollToBottom(this.fullTextContainerEl);
        this.markDocumentModified();
        
        // Auto-save the initial seed text
        this.autoSaveDocument();
    }
    
    handleIterationStart(data) {
        this.currentIteration = data.iteration;
        this.updateIterationInfo(`Iteration: ${data.iteration} - Generating 5 completions...`);
        this.updateStatus(`Starting iteration ${data.iteration}`);
        
        this.completions = {};
        this.completionsContainerEl.innerHTML = '';
        
        for (let i = 1; i <= 5; i++) {
            this.createCompletionSlot(i);
        }
    }
    
    createCompletionSlot(index) {
        const slotEl = document.createElement('div');
        slotEl.className = 'completion-option';
        slotEl.id = `completion-${index}`;
        
        slotEl.innerHTML = `
            <div class="completion-header">
                <span class="completion-number">Option ${index}</span>
                <span class="completion-status" id="status-${index}">Waiting...</span>
            </div>
            <div class="completion-text" id="text-${index}"></div>
        `;
        
        this.completionsContainerEl.appendChild(slotEl);
    }
    
    handleCompletionStart(data) {
        const index = data.index;
        const statusEl = document.getElementById(`status-${index}`);
        const completionEl = document.getElementById(`completion-${index}`);
        
        if (statusEl) {
            statusEl.innerHTML = '<span class="loading-indicator"></span> Generating...';
        }
        if (completionEl) {
            completionEl.classList.add('generating');
        }
        
        this.updateStatus(`Generating completion ${index}/5...`);
    }
    
    handleCompletionToken(data) {
        const index = data.index;
        const textEl = document.getElementById(`text-${index}`);
        
        if (textEl) {
            textEl.textContent = data.full_text;
            this.scrollToBottom(this.completionsContainerEl);
        }
    }
    
    handleCompletionDone(data) {
        const index = data.index;
        const statusEl = document.getElementById(`status-${index}`);
        const completionEl = document.getElementById(`completion-${index}`);
        const textEl = document.getElementById(`text-${index}`);
        
        if (statusEl) {
            statusEl.textContent = 'Complete';
        }
        if (completionEl) {
            completionEl.classList.remove('generating');
        }
        if (textEl) {
            textEl.textContent = data.text;
        }
        
        this.completions[index] = data.text;
        
        this.updateStatus(`Completion ${index}/5 finished`);
        
        // Check if all 5 completions are done and if they're all empty
        if (Object.keys(this.completions).length === 5) {
            const allEmpty = Object.values(this.completions).every(text => !text || text.trim() === '');
            if (allEmpty) {
                this.consecutiveEmptyCount++;
                console.log(`All completions are empty, consecutive empty count: ${this.consecutiveEmptyCount}/3`);
                
                if (this.consecutiveEmptyCount >= 3) {
                    console.log('3 consecutive empty completion sets detected, stopping generation');
                    this.updateStatus('No meaningful content generated for 3 iterations - stopping generation');
                    setTimeout(() => this.stopGeneration(), 2000); // Longer delay to show the message
                    return;
                } else {
                    this.updateStatus(`All completions empty (${this.consecutiveEmptyCount}/3) - continuing...`);
                }
            } else {
                // Reset counter if we got at least one non-empty completion
                this.consecutiveEmptyCount = 0;
            }
        }
        
        // Auto-save after every completion
        this.autoSaveDocument();
    }
    
    handleGradingStart(data) {
        this.updateStatus('Choosing...');
        this.updateIterationInfo(`Iteration: ${this.currentIteration} - Grading...`);
        
        const completions = document.querySelectorAll('.completion-option');
        completions.forEach(el => {
            el.style.opacity = '0.7';
        });
    }
    
    handleGradingDone(data) {
        const chosenIndex = data.chosen_index;
        this.updateStatus(`Chose completion ${chosenIndex}`);
        
        const completions = document.querySelectorAll('.completion-option');
        completions.forEach((el, i) => {
            el.style.opacity = '1';
            if (i + 1 === chosenIndex) {
                el.classList.add('chosen');
            } else {
                el.classList.remove('chosen');
            }
        });
        
        const chosenEl = document.getElementById(`completion-${chosenIndex}`);
        if (chosenEl) {
            chosenEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
    
    handleTextUpdated(data) {
        // Set textarea content directly (newlines preserved automatically)
        this.fullTextEl.value = data.full_text;
        this.scrollToBottom(this.fullTextContainerEl);
        this.updateStatus('Starting next iteration...');
        this.markDocumentModified();
        
        // Auto-save the document with updated content
        this.autoSaveDocument();
    }
    
    // we will never actually get here
    handleComplete(data) {
        this.updateStatus('Complete!');
        this.updateIterationInfo(`Completed after ${this.currentIteration} iterations`);
        this.stopGeneration();
    }
    
    handleDocumentNamed(data) {
        const suggestedName = data.name;
        
        // After 3 iterations, automatically rename without popup
        if (this.currentIteration >= 3) {
            this.automaticRename(suggestedName);
        } else {
            this.updateStatus(`Autorenamed: "${suggestedName}"`);
            this.showRenameModal(suggestedName);
        }
    }
    
    async automaticRename(suggestedName) {
        if (!this.currentDocumentName || !suggestedName || suggestedName === this.currentDocumentName) {
            return;
        }
        
        try {
            const response = await fetch('/api/documents/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    old_name: this.currentDocumentName, 
                    new_name: suggestedName 
                })
            });
            
            if (response.ok) {
                this.currentDocumentName = suggestedName;
                this.updateDocumentName();
                this.loadDocumentList();
                this.updateStatus(`Autorenamed: "${suggestedName}"`);
            } else {
                console.error('Automatic rename failed:', await response.json());
                this.updateStatus('Failed to automatically rename document');
            }
        } catch (error) {
            console.error('Automatic rename error:', error);
            this.updateStatus('Failed to automatically rename document');
        }
    }
    
    showRenameModal(suggestedName) {
        const modalHTML = `
            <div class="modal-overlay" id="renameModal">
                <div class="modal-content">
                    <div class="modal-header">
                        <h3>Rename Document</h3>
                        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
                    </div>
                    <div class="modal-body">
                        <p>AI suggests this name based on your content:</p>
                        <input type="text" id="renameInput" value="${suggestedName}" class="rename-input">
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
                        <button class="btn btn-primary" onclick="window.selfLoomApp.confirmRename()">Rename</button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        
        const input = document.getElementById('renameInput');
        input.focus();
        input.select();
        
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.confirmRename();
            }
        });
    }
    
    async confirmRename() {
         const input = document.getElementById('renameInput');
         const newName = input.value.trim();
         
         if (newName && newName !== this.currentDocumentName) {
             const oldName = this.currentDocumentName;
             
             // Save document with new name
             try {
                 // Get textarea content directly (already plain text with newlines)
                 const content = this.fullTextEl.value;
             const response = await fetch('/api/documents/save', {
                     method: 'POST',
                     headers: { 'Content-Type': 'application/json' },
                     body: JSON.stringify({ name: newName, content })
                 });
                 
             if (response.ok) {
                 const result = await response.json();
                 this.currentDocumentName = result.name || newName;
                     this.documentModified = false;
                     this.updateDocumentName();
                 this.updateStatus(`Document renamed to "${this.currentDocumentName}"`);
                     
                     // Optionally delete old document if it had a timestamp name
                     if (oldName.startsWith('Untitled_')) {
                         try {
                             await fetch(`/api/documents/delete/${encodeURIComponent(oldName)}`, {
                                 method: 'DELETE'
                             });
                         } catch (error) {
                             console.log('Could not delete old document:', error);
                         }
                     }
                 } else {
                     this.updateStatus('Failed to rename document');
                 }
             } catch (error) {
                 console.error('Rename failed:', error);
                 this.updateStatus('Failed to rename document');
             }
         }
         
         // Remove modal
         const modal = document.getElementById('renameModal');
         if (modal) {
             modal.remove();
         }
     }
    
    handleError(data) {
        this.updateStatus(`Error: ${data.message}`);
        console.error('Generation error:', data.message);
        
        const errorEl = document.createElement('div');
        errorEl.className = 'error';
        errorEl.textContent = `Error: ${data.message}`;
        this.completionsContainerEl.prepend(errorEl);
        
        setTimeout(() => {
            if (errorEl.parentElement) {
                errorEl.remove();
            }
        }, 5000);
    }
    
    updateStatus(message) {
        this.statusEl.textContent = message;
        console.log('Status:', message);
    }
    
    updateIterationInfo(message) {
        this.iterationInfoEl.textContent = message;
    }
    

    
    scrollToBottom(element) {
        if (element) {
            element.scrollTo({
                top: element.scrollHeight,
                behavior: 'smooth'
            });
        }
    }
    
    toggleTheme() {
        document.body.classList.toggle('light-mode');
        const isLight = document.body.classList.contains('light-mode');
        localStorage.setItem('theme', isLight ? 'light' : 'dark');
        this.updateThemeButton();
        console.log('Theme switched to:', isLight ? 'light' : 'dark');
    }
    
    updateThemeButton() {
        const themeBtn = document.querySelector('.theme-btn');
        if (themeBtn) {
            const isLight = document.body.classList.contains('light-mode');
            themeBtn.textContent = isLight ? '🌞' : '🌙';
        }
    }
    
    loadTheme() {
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'light') {
            document.body.classList.add('light-mode');
        }
        this.updateThemeButton();
    }
    
    setupResizer() {
        const divider = document.getElementById('divider');
        const container = document.getElementById('container');
        const leftPanel = document.getElementById('leftPanel');
        const rightPanel = document.getElementById('rightPanel');
        
        let isResizing = false;
        
        function getIsMobile() {
            return window.innerWidth <= 1000;
        }
        
        function handleStart(e) {
            isResizing = true;
            container.classList.add('resizing');
            e.preventDefault();
        }
        
        function handleMove(e) {
            if (!isResizing) return;
            
            const isMobile = getIsMobile();
            
            if (isMobile) {
                // Mobile: vertical resize (top/bottom)
                const touch = e.touches && e.touches[0] ? e.touches[0] : null;
                if (!touch) return;
                
                const touchY = touch.clientY;
                const containerRect = container.getBoundingClientRect();
                
                // Calculate relative position within container (0 to 1)
                const relativePosition = (touchY - containerRect.top) / containerRect.height;
                
                // Apply linear correction for Chrome UI offset
                // Error is 0 at top (position=0) and chromeUIHeight at bottom (position=1)
                // But we need less correction - maybe only partial Chrome UI height
                const chromeUIHeight = window.screen.height - window.innerHeight;
                const correction = relativePosition * chromeUIHeight * 0.75; // MAGIC NUMBER
                
                // Corrected touch Y
                const correctedTouchY = touchY - correction;
                
                // Recalculate percentage with corrected position
                let leftPercent = ((correctedTouchY - containerRect.top) / containerRect.height) * 100;
                leftPercent = Math.max(30, Math.min(80, leftPercent));
                
                const rightPercent = 100 - leftPercent;
                
                leftPanel.style.height = `${leftPercent}vh`;
                rightPanel.style.height = `${rightPercent}vh`;
                
                localStorage.setItem('panelSplitMobile', leftPercent);
            } else {
                // Desktop: horizontal resize (left/right)
                const containerRect = container.getBoundingClientRect();
                const mouseX = e.clientX - containerRect.left;
                
                // Check if document sidebar is open and adjust for its width
                const documentSidebar = document.getElementById('documentSidebar');
                const sidebarWidth = documentSidebar && documentSidebar.classList.contains('visible') ? 280 : 0;
                
                // Adjust mouse position if sidebar is open
                const adjustedMouseX = sidebarWidth > 0 ? mouseX - sidebarWidth : mouseX;
                
                let leftPercent = (adjustedMouseX / containerRect.width) * 100;
                leftPercent = Math.max(25, Math.min(75, leftPercent));
                
                const rightPercent = 100 - leftPercent;
                
                leftPanel.style.width = `${leftPercent}%`;
                rightPanel.style.width = `${rightPercent}%`;
                
                localStorage.setItem('panelSplit', leftPercent);
            }
        }
        
        function handleEnd() {
            isResizing = false;
            container.classList.remove('resizing');
        }
        
        if (divider) {
            // Mouse events for desktop
            divider.addEventListener('mousedown', handleStart);
            document.addEventListener('mousemove', handleMove);
            document.addEventListener('mouseup', handleEnd);
            
            // Touch events for mobile
            divider.addEventListener('touchstart', handleStart, { passive: false });
            document.addEventListener('touchmove', handleMove, { passive: false });
            document.addEventListener('touchend', handleEnd);
        }
        
        // Load saved split ratio
        const isMobile = getIsMobile();
        const savedSplit = isMobile ? 
            localStorage.getItem('panelSplitMobile') : 
            localStorage.getItem('panelSplit');
            
        if (savedSplit) {
            const leftPercent = parseFloat(savedSplit);
            const rightPercent = 100 - leftPercent;
            
            if (isMobile) {
                leftPanel.style.height = `${leftPercent}vh`;
                rightPanel.style.height = `${rightPercent}vh`;
            } else {
                leftPanel.style.width = `${leftPercent}%`;
                rightPanel.style.width = `${rightPercent}%`;
            }
        }
        
        // Handle window resize to update mobile/desktop state
        let lastIsMobile = getIsMobile();
        window.addEventListener('resize', () => {
            const currentIsMobile = getIsMobile();
            
            if (lastIsMobile !== currentIsMobile) {
                // Clear saved ratios when switching modes
                localStorage.removeItem('panelSplit');
                localStorage.removeItem('panelSplitMobile');
                lastIsMobile = currentIsMobile;
            }
        });
    }
    
    setupDocumentManager() {
        this.currentDocumentName = 'Untitled';
        this.documentModified = false;
        this.loadDocumentList();
        this.loadSidebarState();
    }
    
    toggleDocumentSidebar() {
        const sidebar = document.getElementById('documentSidebar');
        const leftPanel = document.getElementById('leftPanel');
        const backdrop = document.getElementById('sidebar-backdrop');
        const isVisible = sidebar.classList.contains('visible');
        
        if (isVisible) {
            sidebar.classList.remove('visible');
            leftPanel.classList.remove('sidebar-open');
            if (backdrop) {
                backdrop.classList.remove('show');
            }
            document.body.classList.remove('sidebar-open');
            this.saveSidebarState(false);
        } else {
            sidebar.classList.add('visible');
            leftPanel.classList.add('sidebar-open');
            if (backdrop) {
                backdrop.classList.add('show');
            }
            document.body.classList.add('sidebar-open');
            this.saveSidebarState(true);
        }
    }
    
    async loadDocumentList() {
        try {
            const response = await fetch('/api/documents');
            const documents = await response.json();
            this.renderDocumentList(documents);
        } catch (error) {
            console.error('Failed to load documents:', error);
        }
    }
    
    renderDocumentList(documents) {
        const container = document.getElementById('documentItems');
        
        if (documents.length === 0) {
            container.innerHTML = '<div class="document-item"><span>No documents found</span></div>';
            return;
        }
        
        // Sort documents by modified date (most recent first)
        documents.sort((a, b) => {
            return new Date(b.modified * 1000) - new Date(a.modified * 1000);
        });
        
        container.innerHTML = documents.map(doc => {
            const isActive = doc.name === this.currentDocumentName ? ' active' : '';
            const formattedDate = formatRelativeTime(new Date(doc.modified * 1000));
            return `
                <div class="document-item${isActive}" onclick="window.selfLoomApp.loadDocument('${doc.name}')">
                    <div class="document-info">
                        <div class="document-name">${doc.name}</div>
                        <div class="document-date">${formattedDate}</div>
                    </div>
                    <div class="document-actions" onclick="event.stopPropagation(); window.selfLoomApp.showDocumentMenu('${doc.name}', event)">
                        ⋮
                    </div>
                </div>
            `;
        }).join('');
    }
    
    async newDocument() {
        if (this.documentModified) {
            if (!confirm('You have unsaved changes. Continue without saving?')) {
                return;
            }
        }
        
        this.fullTextEl.readOnly = false;
        this.fullTextEl.value = '';
        this.currentDocumentName = 'Untitled';
        this.temporaryDocumentName = null; // Clear any previous temporary name
        this.documentModified = false;
        this.updateDocumentName();
        this.updateStatus('New document created');
    }
    
    showDocumentMenu(docName, event) {
        // Remove any existing menu
        const existingMenu = document.querySelector('.document-menu');
        if (existingMenu) {
            existingMenu.remove();
        }
        
        // Create menu
        const menu = document.createElement('div');
        menu.className = 'document-menu';
        menu.innerHTML = `
            <div class="menu-item" onclick="window.selfLoomApp.showRenameModal('${docName}')">Rename</div>
            <div class="menu-item" onclick="window.selfLoomApp.downloadDocument('${docName}')">Download as .txt</div>
            <div class="menu-item delete" onclick="window.selfLoomApp.deleteDocument('${docName}')">Delete</div>
        `;
        
        // Position menu
        const rect = event.target.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = rect.bottom + 'px';
        menu.style.left = (rect.left - 80) + 'px'; // Offset to align better
        menu.style.zIndex = '1000';
        
        document.body.appendChild(menu);
        
        // Close menu when clicking outside
        setTimeout(() => {
            document.addEventListener('click', () => {
                menu.remove();
            }, { once: true });
        }, 10);
    }
    
    showRenameModal(docName) {
        // Remove any existing modal
        const existingModal = document.getElementById('renameModal');
        if (existingModal) {
            existingModal.remove();
        }
        
        // Create modal
        const modal = document.createElement('div');
        modal.id = 'renameModal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Rename Document</h3>
                    <button class="modal-close" onclick="document.getElementById('renameModal').remove()">&times;</button>
                </div>
                <div class="modal-body">
                    <input type="text" id="renameInput" value="${docName}" placeholder="Document name">
                </div>
                <div class="modal-footer">
                    <button onclick="document.getElementById('renameModal').remove()">Cancel</button>
                    <button onclick="window.selfLoomApp.confirmRename('${docName}')">Rename</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Focus and select text
        const input = document.getElementById('renameInput');
        input.focus();
        input.select();
    }
    
    async confirmRename(oldName) {
        const input = document.getElementById('renameInput');
        const newName = input.value.trim();
        
        if (newName && newName !== oldName) {
            try {
                const response = await fetch('/api/documents/rename', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ old_name: oldName, new_name: newName })
                });
                
                if (response.ok) {
                    if (this.currentDocumentName === oldName) {
                        this.currentDocumentName = newName;
                        this.updateDocumentName();
                    }
                    this.loadDocumentList();
                    this.updateStatus(`Document renamed`);
                } else {
                    this.updateStatus('Failed to rename document');
                }
            } catch (error) {
                console.error('Rename failed:', error);
                this.updateStatus('Failed to rename document');
            }
        }
        
        document.getElementById('renameModal').remove();
    }
    
    async deleteDocument(docName) {
        if (confirm(`Are you sure you want to delete "${docName}"?`)) {
            try {
                const response = await fetch(`/api/documents/delete/${encodeURIComponent(docName)}`, {
                    method: 'DELETE'
                });
                
                if (response.ok) {
                    if (this.currentDocumentName === docName) {
                        this.newDocument();
                    }
                    this.loadDocumentList();
                    this.updateStatus(`Document "${docName}" deleted`);
                } else {
                    this.updateStatus('Failed to delete document');
                }
            } catch (error) {
                console.error('Delete failed:', error);
                this.updateStatus('Failed to delete document');
            }
        }
    }
    
    
    
    async loadDocument(name) {
        try {
            const response = await fetch(`/api/documents/load/${encodeURIComponent(name)}`);
            if (response.ok) {
                const data = await response.json();
                this.fullTextEl.readOnly = false;
                // Set textarea content directly (newlines preserved automatically)
                this.fullTextEl.value = data.content;
                this.currentDocumentName = name;
                this.temporaryDocumentName = null; // Clear any temporary name
                this.documentModified = false;
                this.updateDocumentName();
                this.updateStatus(`Loaded document`);
                
                // Document list will be updated when loadDocumentList is called
            } else {
                this.updateStatus('Failed to load document');
            }
        } catch (error) {
            console.error('Load failed:', error);
            this.updateStatus('Failed to load document');
        }
    }
    
    updateDocumentName() {
        // Refresh document list to update highlighting
        this.loadDocumentList();
    }
    
    markDocumentModified() {
        if (!this.documentModified) {
            this.documentModified = true;
            this.updateDocumentName();
        }
    }
    
    setupTextInput() {
        // Mark document as modified when user types
        this.fullTextEl.addEventListener('input', () => {
            this.markDocumentModified();
        });
        
        // Handle paste events (textarea handles this natively, but we still want to mark as modified)
        this.fullTextEl.addEventListener('paste', () => {
            // Mark as modified after paste completes
            setTimeout(() => this.markDocumentModified(), 0);
        });
    }
    
    saveSidebarState(isOpen) {
        localStorage.setItem('selfloom_sidebar_open', JSON.stringify(isOpen));
    }
    
    loadSidebarState() {
         // Only auto-open sidebar on desktop, not mobile
         const isDesktop = window.innerWidth > 1000;
         const savedState = localStorage.getItem('selfloom_sidebar_open');
         if (savedState !== null && isDesktop) {
             const isOpen = JSON.parse(savedState);
             if (isOpen) {
                 const sidebar = document.getElementById('documentSidebar');
                 const leftPanel = document.getElementById('leftPanel');
                 sidebar.classList.add('visible');
                 leftPanel.classList.add('sidebar-open');
             }
                 }
    }
    
    async downloadDocument(docName) {
        try {
            const response = await fetch(`/api/documents/load/${encodeURIComponent(docName)}`);
            if (response.ok) {
                const data = await response.json();
                const content = data.content || '';
                
                // Create a blob with the text content
                const blob = new Blob([content], { type: 'text/plain' });
                
                // Create a download link
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${docName}.txt`;
                
                // Trigger download
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                
                // Clean up
                URL.revokeObjectURL(url);
                
                this.updateStatus(`Downloaded "${docName}.txt"`);
            } else {
                this.updateStatus('Failed to download document');
            }
        } catch (error) {
            console.error('Download failed:', error);
            this.updateStatus('Failed to download document');
        }
    }
    
    async autoSaveDocument() {
         // Auto-save during generation
         let nameToSave = this.currentDocumentName;
         
         // If still "Untitled", create a temporary name with timestamp only once
         if (nameToSave === 'Untitled') {
             // Only create timestamp name if we don't already have one
             if (!this.temporaryDocumentName) {
                 const now = new Date();
                 const timestamp = now.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
                 this.temporaryDocumentName = `Untitled_${timestamp}`;
             }
             nameToSave = this.temporaryDocumentName;
         }
         
         try {
             // Get textarea content directly (already plain text with newlines)
             const content = this.fullTextEl.value;
              const response = await fetch('/api/documents/save', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({ name: nameToSave, content })
             });
             
             if (response.ok) {
                  const result = await response.json();
                  const savedName = result.name || nameToSave;
                 // Update current document name if it was "Untitled"
                  if (this.currentDocumentName === 'Untitled' || this.currentDocumentName !== savedName) {
                      this.currentDocumentName = savedName;
                     this.updateDocumentName();
                     // Clear temporary name once we have a real name
                     if (savedName !== this.temporaryDocumentName) {
                         this.temporaryDocumentName = null;
                     }
                 }
                 this.documentModified = false;
                 this.updateDocumentName();
                 
                 // Refresh document list to show the saved document
                 this.loadDocumentList();
                 
                  console.log(`Auto-saved document as "${savedName}"`);
             } else {
                 console.error('Auto-save failed');
             }
         } catch (error) {
             console.error('Auto-save error:', error);
         }
     }

     initializeSettings() {
         // Sync temperature slider with value display
         const temperatureSlider = document.getElementById('temperature');
         const temperatureValue = document.getElementById('temperature-value');
         
         if (temperatureSlider && temperatureValue) {
             temperatureSlider.addEventListener('input', (e) => {
                 temperatureValue.value = e.target.value;
             });
             
             temperatureValue.addEventListener('input', (e) => {
                 temperatureSlider.value = e.target.value;
             });
         }
         
         // Sync min_p slider with value display
         const minPSlider = document.getElementById('min_p');
         const minPValue = document.getElementById('min_p-value');
         
         if (minPSlider && minPValue) {
             minPSlider.addEventListener('input', (e) => {
                 minPValue.value = e.target.value;
             });
             
             minPValue.addEventListener('input', (e) => {
                 minPSlider.value = e.target.value;
             });
         }
         
                 // Load saved models and API key
        this.loadSavedModels();
        this.loadApiKeyStatus();
        
        // Add event listeners to save models when changed
        const baseModelInput = document.getElementById('base-model');
        const graderModelInput = document.getElementById('grader-model');
        const apiKeyInput = document.getElementById('openrouter-api-key');
        
        if (baseModelInput) {
            baseModelInput.addEventListener('change', () => {
                this.saveModels();
            });
        }
        
        if (graderModelInput) {
            graderModelInput.addEventListener('change', () => {
                this.saveModels();
            });
        }
        
        if (apiKeyInput) {
            apiKeyInput.addEventListener('change', () => {
                this.saveApiKey();
            });
            apiKeyInput.addEventListener('blur', () => {
                this.saveApiKey();
            });
        }
        
        // Add grader prompt autosave
        const graderPromptInput = document.getElementById('grader-prompt');
        if (graderPromptInput) {
            graderPromptInput.addEventListener('change', () => {
                this.saveModels();
            });
            graderPromptInput.addEventListener('blur', () => {
                this.saveModels();
            });
        }
     }
     
     async loadSavedModels() {
         try {
             const response = await fetch('/api/get_models');
             if (response.ok) {
                 const models = await response.json();
                 
                 const baseModelInput = document.getElementById('base-model');
                 const graderModelInput = document.getElementById('grader-model');
                 const graderPromptInput = document.getElementById('grader-prompt');
                 
                 if (baseModelInput && models.base_model) {
                     baseModelInput.value = models.base_model;
                 }
                 
                 if (graderModelInput && models.grader_model) {
                     graderModelInput.value = models.grader_model;
                 }
                 
                 if (graderPromptInput && models.grader_prompt) {
                     graderPromptInput.value = models.grader_prompt;
                 }
             }
         } catch (error) {
             console.error('Failed to load saved models:', error);
         }
     }
     
     async saveModels() {
         try {
             const baseModelInput = document.getElementById('base-model');
             const graderModelInput = document.getElementById('grader-model');
             const graderPromptInput = document.getElementById('grader-prompt');
             
             const baseModel = baseModelInput ? baseModelInput.value : '';
             const graderModel = graderModelInput ? graderModelInput.value : '';
             const graderPrompt = graderPromptInput ? graderPromptInput.value : '';
             
             const response = await fetch('/api/save_models', {
                 method: 'POST',
                 headers: {
                     'Content-Type': 'application/json',
                 },
                 body: JSON.stringify({
                     base_model: baseModel,
                     grader_model: graderModel,
                     grader_prompt: graderPrompt
                 })
             });
             
             if (!response.ok) {
                 console.error('Failed to save models');
             }
                 } catch (error) {
            console.error('Failed to save models:', error);
        }
    }

    async loadApiKeyStatus() {
        try {
            const response = await fetch('/api/get_token_status');
            if (response.ok) {
                const data = await response.json();
                const apiKeyInput = document.getElementById('openrouter-api-key');
                
                if (apiKeyInput && data.has_token) {
                    apiKeyInput.placeholder = data.masked_token;
                    apiKeyInput.value = ''; // Don't show actual key, just placeholder
                }
            }
        } catch (error) {
            console.error('Failed to load API key status:', error);
        }
    }

    async saveApiKey() {
        try {
            const apiKeyInput = document.getElementById('openrouter-api-key');
            const apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';
            
            // Only save if there's actually a value entered
            if (!apiKey) {
                return;
            }
            
            // Basic validation for OpenRouter API key format
            if (!apiKey.startsWith('sk-or-v1-')) {
                this.updateStatus('Invalid API key format. OpenRouter keys start with "sk-or-v1-"');
                return;
            }
            
            const response = await fetch('/set_token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    'token': apiKey
                })
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    console.log('API key saved successfully');
                    // Clear the input and reload the status to show masked version
                    apiKeyInput.value = '';
                    this.loadApiKeyStatus();
                    this.updateStatus('API key updated successfully');
                } else {
                    console.error('Failed to save API key:', data.error);
                    this.updateStatus('Failed to save API key');
                }
            } else {
                console.error('Failed to save API key: Server error');
                this.updateStatus('Failed to save API key');
            }
        } catch (error) {
            console.error('Failed to save API key:', error);
            this.updateStatus('Failed to save API key');
        }
    }

     toggleSettingsInputs(enabled) {
         const baseModelInput = document.getElementById('base-model');
         const graderModelInput = document.getElementById('grader-model');
         const apiKeyInput = document.getElementById('openrouter-api-key');
         
         if (baseModelInput) {
             baseModelInput.disabled = !enabled;
         }
         
         if (graderModelInput) {
             graderModelInput.disabled = !enabled;
         }
         
         if (apiKeyInput) {
             apiKeyInput.disabled = !enabled;
         }
     }

     toggleSettingsAccordion() {
         const button = document.querySelector('.accordion-button');
         const collapse = document.getElementById('settingsCollapse');
         
         if (button && collapse) {
             const isCollapsed = button.classList.contains('collapsed');
             
             if (isCollapsed) {
                 // Expand
                 button.classList.remove('collapsed');
                 collapse.classList.remove('collapsed');
             } else {
                 // Collapse
                 button.classList.add('collapsed');
                 collapse.classList.add('collapsed');
             }
         }
     }

     setupMobileBackdrop() {
         const backdrop = document.getElementById('sidebar-backdrop');
         if (backdrop) {
             backdrop.addEventListener('click', () => {
                 // Close sidebar when backdrop is clicked
                 const sidebar = document.getElementById('documentSidebar');
                 if (sidebar && sidebar.classList.contains('visible')) {
                     this.toggleDocumentSidebar();
                 }
             });
         }

         // Handle window resize to close mobile sidebar on desktop
         window.addEventListener('resize', () => {
             const isDesktop = window.innerWidth > 1000;
             const sidebar = document.getElementById('documentSidebar');
             const backdrop = document.getElementById('sidebar-backdrop');
             
             if (isDesktop && sidebar) {
                 // On desktop, restore sidebar state from localStorage
                 const savedState = localStorage.getItem('selfloom_sidebar_open');
                 const isVisible = savedState !== null ? JSON.parse(savedState) : false;
                 const leftPanel = document.getElementById('leftPanel');
                 
                 if (isVisible) {
                     sidebar.classList.add('visible');
                     if (leftPanel) leftPanel.classList.add('sidebar-open');
                 } else {
                     sidebar.classList.remove('visible');
                     if (leftPanel) leftPanel.classList.remove('sidebar-open');
                 }
                 
                 if (backdrop) backdrop.classList.remove('show');
                 document.body.classList.remove('sidebar-open');
             }
         });
         
         // Force viewport to stay in place on mobile
         if (window.innerWidth <= 1000) {
             this.setupMobileViewport();
         }
     }
     
     handleTokenSubmit(e) {
         e.preventDefault();
         const tokenInput = document.getElementById('token-input');
         const token = tokenInput.value.trim();
         
         if (!token) {
             alert('Please enter an API token');
             return;
         }
         
         console.log('Submitting token...');
         fetch('/set_token', {
             method: 'POST',
             headers: {
                 'Content-Type': 'application/x-www-form-urlencoded',
             },
             body: new URLSearchParams({
                 'token': token
             })
         })
         .then(response => {
             console.log('Token response status:', response.status);
             return response.json();
         })
         .then(data => {
             console.log('Token response data:', data);
             if (data.success) {
                 // Close the modal
                 document.getElementById('tokenModal').style.display = 'none';
                 
                 // Clear the input
                 tokenInput.value = '';
                 
                 // Reload the page to ensure all state is updated
                 window.location.reload();
             } else {
                 console.error('Error setting token:', data.error);
                 alert('Error setting token: ' + (data.error || 'Unknown error'));
             }
         })
         .catch(error => {
             console.error('Error setting token:', error);
             alert('Error setting token: ' + error.message);
         });
     }
     
     setupMobileViewport() {
         // Prevent address bar from hiding content
         let vh = window.innerHeight * 0.01;
         document.documentElement.style.setProperty('--vh', `${vh}px`);
         
         // Update on resize
         window.addEventListener('resize', () => {
             vh = window.innerHeight * 0.01;
             document.documentElement.style.setProperty('--vh', `${vh}px`);
         });
         
         // Force viewport to stay in place
         window.addEventListener('scroll', (e) => {
             if (window.innerWidth <= 1000) {
                 e.preventDefault();
                 window.scrollTo({
                     top: 0,
                     behavior: 'smooth'
                 });
             }
         }, { passive: false });
         
         // Prevent zoom on double tap
         let lastTouchEnd = 0;
         document.addEventListener('touchend', (e) => {
             const now = (new Date()).getTime();
             if (now - lastTouchEnd <= 300) {
                 e.preventDefault();
             }
             lastTouchEnd = now;
         }, false);
     }
}

class AutoScroller {
    constructor(element) {
        this.element = element;
        this.userScrolled = false;
        this.scrollThreshold = 50;
        
        this.element.addEventListener('scroll', () => {
            const { scrollTop, scrollHeight, clientHeight } = this.element;
            const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
            this.userScrolled = distanceFromBottom > this.scrollThreshold;
        });
    }
    
    scrollToBottomIfNeeded() {
        if (!this.userScrolled) {
            this.element.scrollTo({
                top: this.element.scrollHeight,
                behavior: 'smooth'
            });
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log('Initializing Self-Loom');
    window.selfLoomApp = new SelfLoomApp();
    
    const leftScroller = new AutoScroller(document.querySelector('.full-text-container'));
    const rightScroller = new AutoScroller(document.querySelector('.completions-container'));
    
    const originalScrollToBottom = window.selfLoomApp.scrollToBottom;
    window.selfLoomApp.scrollToBottom = (element) => {
        if (element === document.querySelector('.full-text-container')) {
            leftScroller.scrollToBottomIfNeeded();
        } else if (element === document.querySelector('.completions-container')) {
            rightScroller.scrollToBottomIfNeeded();
        } else {
            originalScrollToBottom.call(window.selfLoomApp, element);
        }
    };
});

/**
 * Format a date relative to now (e.g. "2 hours ago")
 * @param {Date} date - Date to format  
 * @return {String} Formatted relative time string
 */
function formatRelativeTime(date) {
    const now = new Date();
    const diffInSeconds = Math.floor((now - date) / 1000);
    
    if (diffInSeconds < 60) {
        return 'just now';
    }
    
    const diffInMinutes = Math.floor(diffInSeconds / 60);
    if (diffInMinutes < 60) {
        return `${diffInMinutes}m ago`;
    }
    
    const diffInHours = Math.floor(diffInMinutes / 60);
    if (diffInHours < 24) {
        return `${diffInHours}h ago`;
    }
    
    const diffInDays = Math.floor(diffInHours / 24);
    if (diffInDays < 30) {
        return `${diffInDays}d ago`;
    }
    
    return date.toLocaleDateString();
}

window.addEventListener('beforeunload', () => {
    if (window.selfLoomApp && window.selfLoomApp.eventSource) {
        window.selfLoomApp.eventSource.close();
    }
});