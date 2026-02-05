// ===================================
// FINANCE TRACKER - MAIN JAVASCRIPT
// Part 1: Data Model, State Management, Import/Export
// ===================================

// ===================================
// STATE MANAGEMENT
// ===================================
class FinanceTracker {
    constructor() {
        this.currentYear = new Date().getFullYear();
        this.currentView = 'dashboard';
        this.data = this.initializeData();
        this.undoStack = [];
        this.redoStack = [];
        this.maxUndoSteps = 50;
    }

    initializeData() {
        return {
            version: '2.0', // Updated for master list architecture
            lastModified: new Date().toISOString(),
            
            // MASTER LISTS - Source of truth for all items
            creditCards: [],
            loans: [],
            subscriptions: [],
            
            // YEARS - Only monthly data and transaction logs
            years: {
                [this.currentYear]: this.createYearData()
            },
            categories: this.getDefaultCategories(),
            budgets: {}
        };
    }

    createYearData() {
        return {
            monthly: this.createMonthlyData(),
            creditLogs: {},  // Logs indexed by card ID
            loanLogs: {}     // Logs indexed by loan ID
        };
    }

    createMonthlyData() {
        const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const data = {
            moneyIn: {},
            debt: {},
            moneyOut: {},
            notes: {}
        };

        months.forEach(month => {
            data.moneyIn[month] = {
                total: 0,
                workIncome: 0,
                secondaryIncome: 0,
                otherIncome: 0
            };
            data.debt[month] = {
                total: 0,
                loanBalance: 0,
                creditBalance: 0
            };
            data.moneyOut[month] = {
                total: 0,
                creditPayments: 0,
                loanPayments: 0,
                otherSpending: 0,
                subscriptions: 0,
                costOfLiving: 0,
                savings: 0
            };
            data.notes[month] = '';
        });

        return data;
    }

    getDefaultCategories() {
        return {
            income: [
                { id: 'workIncome', name: 'Work Income', editable: false },
                { id: 'secondaryIncome', name: 'Secondary Income', editable: true },
                { id: 'otherIncome', name: 'Other Income', editable: true }
            ],
            debt: [
                { id: 'loanBalance', name: 'Loan Balance', editable: false },
                { id: 'creditBalance', name: 'Credit Balance', editable: false }
            ],
            spending: [
                { id: 'savings', name: 'Savings', editable: false },
                { id: 'creditPayments', name: 'Credit Payments', editable: false },
                { id: 'loanPayments', name: 'Loan Payments', editable: false },
                { id: 'otherSpending', name: 'Other Spending', editable: true },
                { id: 'subscriptions', name: 'Subscriptions', editable: false },
                { id: 'costOfLiving', name: 'Cost of Living', editable: true }
            ]
        };
    }

    // Get current year data
    getYearData(year = this.currentYear) {
        if (!this.data.years[year]) {
            this.data.years[year] = this.createYearData();
        }
        return this.data.years[year];
    }

    // Save state for undo/redo
    saveState() {
        const state = JSON.stringify(this.data);
        this.undoStack.push(state);
        if (this.undoStack.length > this.maxUndoSteps) {
            this.undoStack.shift();
        }
        this.redoStack = []; // Clear redo stack on new action
        this.data.lastModified = new Date().toISOString();
    }

    // Undo last action
    undo() {
        if (this.undoStack.length === 0) {
            showToast('Nothing to undo', 'info');
            return false;
        }
        const currentState = JSON.stringify(this.data);
        this.redoStack.push(currentState);
        const previousState = this.undoStack.pop();
        this.data = JSON.parse(previousState);
        return true;
    }

    // Redo last undone action
    redo() {
        if (this.redoStack.length === 0) {
            showToast('Nothing to redo', 'info');
            return false;
        }
        const currentState = JSON.stringify(this.data);
        this.undoStack.push(currentState);
        const nextState = this.redoStack.pop();
        this.data = JSON.parse(nextState);
        return true;
    }

    // Export data as JSON
    exportData() {
        return JSON.stringify(this.data, null, 2);
    }

    // Import data from JSON
    importData(jsonString) {
        try {
            const parsed = JSON.parse(jsonString);
            if (!parsed.version || !parsed.years) {
                throw new Error('Invalid data format');
            }
            this.saveState();
            this.data = parsed;
            return true;
        } catch (error) {
            console.error('Import error:', error);
            return false;
        }
    }

    // Calculate monthly totals
    calculateMonthlyTotals(month) {
        const yearData = this.getYearData();
        const monthly = yearData.monthly;

        // Calculate Money IN total
        const moneyIn = monthly.moneyIn[month];
        moneyIn.total = moneyIn.workIncome + moneyIn.secondaryIncome + moneyIn.otherIncome;

        // Calculate DEBT total
        const debt = monthly.debt[month];
        debt.total = debt.loanBalance + debt.creditBalance;

        // Calculate Money OUT total
        const moneyOut = monthly.moneyOut[month];
        moneyOut.total = moneyOut.savings + moneyOut.creditPayments + moneyOut.loanPayments + 
                         moneyOut.otherSpending + moneyOut.subscriptions + moneyOut.costOfLiving;
    }

    // Calculate shift (change from previous month)
    calculateShift(category, month) {
        const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const currentIndex = months.indexOf(month);
        
        if (currentIndex === 0) return 0; // No previous month in January
        
        const prevMonth = months[currentIndex - 1];
        const yearData = this.getYearData();
        const current = yearData.monthly[category][month].total;
        const previous = yearData.monthly[category][prevMonth].total;
        
        return current - previous;
    }
}

// ===================================
// GLOBAL INSTANCE
// ===================================
const tracker = new FinanceTracker();

// ===================================
// UTILITY FUNCTIONS
// ===================================
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
    }).format(amount);
}

function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function parseDate(input) {
    // Handle various date formats: MM/DD/YYYY, YYYY-MM-DD, etc.
    const date = new Date(input);
    return isNaN(date) ? null : date;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <div>
            ${type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ'}
        </div>
        <div>${message}</div>
    `;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideInRight 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function showModal(content) {
    const overlay = document.getElementById('modalOverlay');
    const body = document.getElementById('modalBody');
    body.innerHTML = content;
    overlay.classList.add('active');
}

function closeModal() {
    const overlay = document.getElementById('modalOverlay');
    overlay.classList.remove('active');
}

// ===================================
// NAVIGATION
// ===================================
function switchView(viewName) {
    // Hide all views
    document.querySelectorAll('.view').forEach(view => {
        view.classList.remove('active');
    });
    
    // Show selected view
    const targetView = document.getElementById(`${viewName}View`);
    if (targetView) {
        targetView.classList.add('active');
    }
    
    // Update nav links
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.remove('active');
        if (link.dataset.view === viewName) {
            link.classList.add('active');
        }
    });
    
    tracker.currentView = viewName;
    
    // Render the view
    renderView(viewName);
}

function renderView(viewName) {
    switch(viewName) {
        case 'dashboard':
            renderDashboard();
            break;
        case 'monthly':
            renderMonthlyView();
            break;
        case 'credit':
            renderCreditView();
            break;
        case 'loans':
            renderLoansView();
            break;
        case 'subscriptions':
            renderSubscriptionsView();
            break;
        case 'calendar':
            renderCalendar();
            break;
        case 'settings':
            // Settings view is mostly static
            break;
    }
}

// ===================================
// THEME TOGGLE
// ===================================
function toggleTheme() {
    const body = document.body;
    body.classList.toggle('dark-mode');
    body.classList.toggle('light-mode');
    
    const isDark = body.classList.contains('dark-mode');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
}

function loadTheme() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.remove('light-mode');
        document.body.classList.add('dark-mode');
    }
}

// ===================================
// DATA IMPORT/EXPORT
// ===================================
async function exportToClipboard() {
    try {
        const jsonData = tracker.exportData();
        await navigator.clipboard.writeText(jsonData);
        showToast('Data exported to clipboard!', 'success');
        
        // Also populate textarea
        const textarea = document.getElementById('jsonTextarea');
        if (textarea) {
            textarea.value = jsonData;
        }
    } catch (error) {
        showToast('Failed to copy to clipboard', 'error');
        console.error(error);
    }
}

async function importFromClipboard() {
    try {
        const jsonData = await navigator.clipboard.readText();
        if (tracker.importData(jsonData)) {
            showToast('Data imported successfully!', 'success');
            renderView(tracker.currentView);
        } else {
            showToast('Invalid JSON data', 'error');
        }
    } catch (error) {
        showToast('Failed to read clipboard', 'error');
        console.error(error);
    }
}

function importFromTextarea() {
    const textarea = document.getElementById('jsonTextarea');
    const jsonData = textarea.value.trim();
    
    if (!jsonData) {
        showToast('Please paste JSON data first', 'error');
        return;
    }
    
    if (tracker.importData(jsonData)) {
        showToast('Data imported successfully!', 'success');
        renderView(tracker.currentView);
        textarea.value = '';
    } else {
        showToast('Invalid JSON data', 'error');
    }
}

function resetAllData() {
    if (confirm('Are you sure you want to reset ALL data? This cannot be undone!')) {
        if (confirm('Really? This will delete everything. Last chance!')) {
            tracker.data = tracker.initializeData();
            tracker.undoStack = [];
            tracker.redoStack = [];
            showToast('All data has been reset', 'info');
            renderView(tracker.currentView);
        }
    }
}

// ===================================
// YEAR NAVIGATION
// ===================================
function changeYear(delta) {
    tracker.currentYear += delta;
    updateYearDisplays();
    renderView(tracker.currentView);
}

function updateYearDisplays() {
    document.getElementById('currentYear').textContent = tracker.currentYear;
    document.getElementById('monthlyViewYear').textContent = tracker.currentYear;
    document.getElementById('creditViewYear').textContent = tracker.currentYear;
    document.getElementById('loansViewYear').textContent = tracker.currentYear;
    document.getElementById('subscriptionsViewYear').textContent = tracker.currentYear;
}

// ===================================
// INITIALIZATION
// ===================================
document.addEventListener('DOMContentLoaded', () => {
    // Load theme
    loadTheme();
    
    // Set up theme toggle
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
    
    // Set up navigation
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            switchView(link.dataset.view);
        });
    });
    
    // Set up year navigation
    document.getElementById('prevYear').addEventListener('click', () => changeYear(-1));
    document.getElementById('nextYear').addEventListener('click', () => changeYear(1));
    
    // Set up modal close
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('modalOverlay').addEventListener('click', (e) => {
        if (e.target.id === 'modalOverlay') closeModal();
    });
    
    // Set up data controls
    document.getElementById('exportBtn').addEventListener('click', exportToClipboard);
    document.getElementById('importBtn').addEventListener('click', importFromClipboard);
    document.getElementById('exportDataBtn').addEventListener('click', exportToClipboard);
    document.getElementById('importClipboardBtn').addEventListener('click', importFromClipboard);
    document.getElementById('importTextareaBtn').addEventListener('click', importFromTextarea);
    document.getElementById('resetDataBtn').addEventListener('click', resetAllData);
    
    // Set up keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                if (tracker.undo()) {
                    showToast('Undone', 'info');
                    renderView(tracker.currentView);
                }
            } else if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) {
                e.preventDefault();
                if (tracker.redo()) {
                    showToast('Redone', 'info');
                    renderView(tracker.currentView);
                }
            }
        }
    });
    
    // Initialize year displays
    updateYearDisplays();
    
    // Render initial view
    renderView('dashboard');
});
