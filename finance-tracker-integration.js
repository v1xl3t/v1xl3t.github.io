// ===================================
// FINANCE TRACKER - PHASE 2
// Data Integration & Automatic Calculations
// ===================================

// ===================================
// AUTOMATIC DATA SYNCHRONIZATION
// ===================================

/**
 * Main function to recalculate all monthly totals from source data
 * Call this whenever credit, loan, or subscription data changes
 */
function recalculateMonthlyFromSources(year = tracker.currentYear) {
    const yearData = tracker.getYearData(year);
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    
    months.forEach(month => {
        syncCreditDataToMonthly(month, yearData);
        syncLoanDataToMonthly(month, yearData);
        syncSubscriptionDataToMonthly(month, yearData);
        tracker.calculateMonthlyTotals(month);
    });
}

/**
 * Sync credit card data to monthly overview
 * - Calculate total credit payments for the month
 * - Calculate total credit balance for the month
 */
function syncCreditDataToMonthly(month, yearData) {
    // Get active credit cards for this year
    const activeCards = getActiveItems(tracker.data.creditCards || [], tracker.currentYear);
    
    if (!activeCards || activeCards.length === 0) {
        yearData.monthly.moneyOut[month].creditPayments = 0;
        yearData.monthly.debt[month].creditBalance = 0;
        return;
    }
    
    let totalPayments = 0;
    let totalBalance = 0;
    
    activeCards.forEach(card => {
        const log = getItemLog(card.id, tracker.currentYear, 'credit');
        const monthLog = log[month];
        
        if (monthLog) {
            // Sum all payment amounts for this month
            if (monthLog.paymentAmounts && Array.isArray(monthLog.paymentAmounts)) {
                totalPayments += monthLog.paymentAmounts.reduce((sum, amt) => sum + (parseFloat(amt) || 0), 0);
            }
            
            // Get balance after payments
            totalBalance += parseFloat(monthLog.balancePostPay) || 0;
        }
    });
    
    yearData.monthly.moneyOut[month].creditPayments = totalPayments;
    yearData.monthly.debt[month].creditBalance = totalBalance;
}

/**
 * Sync loan data to monthly overview
 * - Calculate total loan payments for the month
 * - Calculate total loan balance for the month
 */
function syncLoanDataToMonthly(month, yearData) {
    // Get active loans for this year
    const activeLoans = getActiveItems(tracker.data.loans || [], tracker.currentYear);
    
    if (!activeLoans || activeLoans.length === 0) {
        yearData.monthly.moneyOut[month].loanPayments = 0;
        yearData.monthly.debt[month].loanBalance = 0;
        return;
    }
    
    let totalPayments = 0;
    let totalBalance = 0;
    
    activeLoans.forEach(loan => {
        const log = getItemLog(loan.id, tracker.currentYear, 'loan');
        const monthLog = log[month];
        
        if (monthLog) {
            // Sum all payment amounts for this month
            if (monthLog.paymentAmounts && Array.isArray(monthLog.paymentAmounts)) {
                totalPayments += monthLog.paymentAmounts.reduce((sum, amt) => sum + (parseFloat(amt) || 0), 0);
            }
            
            // Get balance after payments
            totalBalance += parseFloat(monthLog.balancePostPay) || 0;
        }
    });
    
    yearData.monthly.moneyOut[month].loanPayments = totalPayments;
    yearData.monthly.debt[month].loanBalance = totalBalance;
}

/**
 * Sync subscription data to monthly overview
 * - Calculate total subscription costs for the month
 */
function syncSubscriptionDataToMonthly(month, yearData) {
    if (!yearData.subscriptions || yearData.subscriptions.length === 0) {
        yearData.monthly.moneyOut[month].subscriptions = 0;
        return;
    }
    
    const monthIndex = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(month);
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                        'July', 'August', 'September', 'October', 'November', 'December'];
    const currentMonthName = monthNames[monthIndex];
    
    let totalSubscriptions = 0;
    
    yearData.subscriptions.forEach(sub => {
        // Skip discontinued subscriptions
        if (sub.renewal === 'Discontinued' || sub.renewal === 'discontinued') {
            return;
        }
        
        const renewal = sub.renewal || 'Monthly';
        
        if (renewal === 'Monthly') {
            // Monthly subscriptions charge every month
            totalSubscriptions += parseFloat(sub.monthlyTotal) || parseFloat(sub.charge) || 0;
        } else if (renewal === currentMonthName) {
            // Annual subscription that renews this month
            totalSubscriptions += parseFloat(sub.charge) || 0;
        } else if (renewal === 'Custom') {
            // For custom, we'll use the monthly total
            totalSubscriptions += parseFloat(sub.monthlyTotal) || 0;
        }
    });
    
    yearData.monthly.moneyOut[month].subscriptions = totalSubscriptions;
}

// ===================================
// ENHANCED UPDATE FUNCTIONS
// These override/extend the existing functions to trigger recalculation
// ===================================

/**
 * Enhanced version of updateCreditLog that triggers monthly recalculation
 */
const originalUpdateCreditLog = window.updateCreditLog;
window.updateCreditLog = function(cardIndex, month, field, value) {
    const yearData = tracker.getYearData();
    tracker.saveState();
    
    if (!yearData.credit[cardIndex].log[month]) {
        yearData.credit[cardIndex].log[month] = {};
    }
    
    yearData.credit[cardIndex].log[month][field] = value;
    
    // Trigger recalculation
    syncCreditDataToMonthly(month, yearData);
    tracker.calculateMonthlyTotals(month);
    
    renderCreditView();
    
    // If monthly view is active, update it too
    if (tracker.currentView === 'monthly') {
        renderMonthlyView();
    }
    
    // Update dashboard if it's showing current month
    if (tracker.currentView === 'dashboard') {
        renderDashboard();
    }
    
    showToast('Updated and synced to Monthly Overview', 'success');
};

/**
 * Enhanced version of addCreditPaymentAmount that triggers recalculation
 */
const originalAddCreditPaymentAmount = window.addCreditPaymentAmount;
window.addCreditPaymentAmount = function(cardIndex, month) {
    const amount = prompt('Enter payment amount (e.g., 150.00):');
    if (!amount) return;

    const yearData = tracker.getYearData();
    tracker.saveState();
    
    if (!yearData.credit[cardIndex].log[month]) {
        yearData.credit[cardIndex].log[month] = { paymentDates: [], paymentAmounts: [] };
    }
    
    if (!yearData.credit[cardIndex].log[month].paymentAmounts) {
        yearData.credit[cardIndex].log[month].paymentAmounts = [];
    }
    
    yearData.credit[cardIndex].log[month].paymentAmounts.push(parseFloat(amount));
    
    // Trigger recalculation
    syncCreditDataToMonthly(month, yearData);
    tracker.calculateMonthlyTotals(month);
    
    renderCreditView();
    
    if (tracker.currentView === 'monthly') {
        renderMonthlyView();
    }
    
    showToast('Payment added and synced to Monthly Overview', 'success');
};

/**
 * Enhanced version of updateLoanLog that triggers recalculation
 */
const originalUpdateLoanLog = window.updateLoanLog;
window.updateLoanLog = function(loanIndex, month, field, value) {
    const yearData = tracker.getYearData();
    tracker.saveState();
    
    if (!yearData.loans[loanIndex].log[month]) {
        yearData.loans[loanIndex].log[month] = {};
    }
    
    yearData.loans[loanIndex].log[month][field] = value;
    
    // Trigger recalculation
    syncLoanDataToMonthly(month, yearData);
    tracker.calculateMonthlyTotals(month);
    
    if (tracker.currentView === 'monthly') {
        renderMonthlyView();
    }
    
    if (tracker.currentView === 'dashboard') {
        renderDashboard();
    }
    
    showToast('Updated and synced to Monthly Overview', 'success');
};

/**
 * Add loan payment amount with auto-sync
 */
window.addLoanPaymentAmount = function(loanIndex, month) {
    const amount = prompt('Enter payment amount (e.g., 350.00):');
    if (!amount) return;

    const yearData = tracker.getYearData();
    tracker.saveState();
    
    if (!yearData.loans[loanIndex].log[month]) {
        yearData.loans[loanIndex].log[month] = { paymentDates: [], paymentAmounts: [] };
    }
    
    if (!yearData.loans[loanIndex].log[month].paymentAmounts) {
        yearData.loans[loanIndex].log[month].paymentAmounts = [];
    }
    
    yearData.loans[loanIndex].log[month].paymentAmounts.push(parseFloat(amount));
    
    // Trigger recalculation
    syncLoanDataToMonthly(month, yearData);
    tracker.calculateMonthlyTotals(month);
    
    renderLoansView();
    
    if (tracker.currentView === 'monthly') {
        renderMonthlyView();
    }
    
    showToast('Payment added and synced to Monthly Overview', 'success');
};

/**
 * Add loan payment date
 */
window.addLoanPaymentDate = function(loanIndex, month) {
    const date = prompt('Enter payment date (e.g., 26 01 15 - January 15th, 2026):');
    if (!date) return;

    const yearData = tracker.getYearData();
    tracker.saveState();
    
    if (!yearData.loans[loanIndex].log[month]) {
        yearData.loans[loanIndex].log[month] = { paymentDates: [], paymentAmounts: [] };
    }
    
    if (!yearData.loans[loanIndex].log[month].paymentDates) {
        yearData.loans[loanIndex].log[month].paymentDates = [];
    }
    
    yearData.loans[loanIndex].log[month].paymentDates.push(date);
    renderLoansView();
    showToast('Payment date added', 'success');
};

/**
 * Enhanced deleteSubscription that triggers recalculation
 */
const originalDeleteSubscription = window.deleteSubscription;
window.deleteSubscription = function(index) {
    if (!confirm('Are you sure you want to delete this subscription?')) return;
    
    const yearData = tracker.getYearData();
    tracker.saveState();
    yearData.subscriptions.splice(index, 1);
    
    // Recalculate all months since subscriptions affect multiple months
    recalculateMonthlyFromSources();
    
    renderSubscriptionsView();
    
    if (tracker.currentView === 'monthly') {
        renderMonthlyView();
    }
    
    showToast('Subscription deleted and Monthly Overview updated', 'success');
};

// ===================================
// INITIALIZATION HOOK
// ===================================

/**
 * Run recalculation when data is imported
 */
const originalImportData = tracker.importData.bind(tracker);
tracker.importData = function(jsonString) {
    const result = originalImportData(jsonString);
    if (result) {
        // Recalculate all data after import
        Object.keys(this.data.years).forEach(year => {
            recalculateMonthlyFromSources(parseInt(year));
        });
    }
    return result;
};

/**
 * Add a manual recalculation button (for debugging/verification)
 */
window.manualRecalculateAll = function() {
    tracker.saveState();
    Object.keys(tracker.data.years).forEach(year => {
        recalculateMonthlyFromSources(parseInt(year));
    });
    renderView(tracker.currentView);
    showToast('All data recalculated!', 'success');
};

// Run initial calculation on page load (after a small delay to ensure everything is loaded)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
            recalculateMonthlyFromSources();
        }, 100);
    });
} else {
    setTimeout(() => {
        recalculateMonthlyFromSources();
    }, 100);
}

console.log('✅ Phase 2: Data Integration Module Loaded');
