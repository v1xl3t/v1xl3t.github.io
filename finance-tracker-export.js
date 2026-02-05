// ===================================
// FINANCE TRACKER - PHASE 3
// CSV Export Functionality
// ===================================

/**
 * Export monthly overview to CSV
 */
function exportMonthlyToCSV() {
    const yearData = tracker.getYearData();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthKeys = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    
    let csv = `${tracker.currentYear} Monthly Overview\n\n`;
    
    // Header row
    csv += 'Category,' + months.join(',') + '\n';
    
    // SAVINGS
    csv += 'Savings,';
    csv += monthKeys.map(m => yearData.monthly.moneyOut[m].savings || 0).join(',') + '\n';
    csv += '\n';
    
    // MONEY IN
    csv += 'MONEY IN\n';
    csv += 'Total Money In,';
    csv += monthKeys.map(m => yearData.monthly.moneyIn[m].total || 0).join(',') + '\n';
    
    tracker.data.categories.income.forEach(cat => {
        csv += `${cat.name},`;
        csv += monthKeys.map(m => yearData.monthly.moneyIn[m][cat.id] || 0).join(',') + '\n';
    });
    csv += '\n';
    
    // DEBT
    csv += 'DEBT\n';
    csv += 'Total Debt,';
    csv += monthKeys.map(m => yearData.monthly.debt[m].total || 0).join(',') + '\n';
    csv += 'Loan Balance,';
    csv += monthKeys.map(m => yearData.monthly.debt[m].loanBalance || 0).join(',') + '\n';
    csv += 'Credit Balance,';
    csv += monthKeys.map(m => yearData.monthly.debt[m].creditBalance || 0).join(',') + '\n';
    csv += '\n';
    
    // MONEY OUT
    csv += 'MONEY OUT\n';
    csv += 'Total Money Out,';
    csv += monthKeys.map(m => yearData.monthly.moneyOut[m].total || 0).join(',') + '\n';
    
    tracker.data.categories.spending.forEach(cat => {
        csv += `${cat.name},`;
        csv += monthKeys.map(m => yearData.monthly.moneyOut[m][cat.id] || 0).join(',') + '\n';
    });
    
    downloadCSV(csv, `Finance_Tracker_Monthly_${tracker.currentYear}.csv`);
    showToast('Monthly overview exported to CSV!', 'success');
}

/**
 * Export credit cards to CSV
 */
function exportCreditToCSV() {
    const yearData = tracker.getYearData();
    
    if (!yearData.credit || yearData.credit.length === 0) {
        showToast('No credit card data to export', 'error');
        return;
    }
    
    let csv = `${tracker.currentYear} Credit Cards\n\n`;
    
    yearData.credit.forEach((card, index) => {
        csv += `Card: ${card.name || 'Card ' + (index + 1)}\n`;
        csv += `Type: ${card.type || 'N/A'}\n`;
        csv += `Limit: ${card.limit || 0}\n`;
        csv += `Due Date: ${card.dueDate || 'N/A'}\n`;
        csv += `Closing Date: ${card.closingDate || 'N/A'}\n`;
        csv += `Notes: ${card.notes || ''}\n`;
        csv += '\nMonth,Payment Dates,Payment Amounts,Balance Post-Pay,Available Credit\n';
        
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                        'July', 'August', 'September', 'October', 'November', 'December'];
        const monthKeys = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        
        monthKeys.forEach((key, i) => {
            const log = card.log?.[key] || {};
            const dates = (log.paymentDates || []).join('; ');
            const amounts = (log.paymentAmounts || []).map(a => '$' + a.toFixed(2)).join('; ');
            const balance = log.balancePostPay || 0;
            const available = (card.limit || 0) - balance;
            
            csv += `${months[i]},${dates},${amounts},${balance.toFixed(2)},${available.toFixed(2)}\n`;
        });
        
        csv += '\n\n';
    });
    
    downloadCSV(csv, `Finance_Tracker_Credit_${tracker.currentYear}.csv`);
    showToast('Credit cards exported to CSV!', 'success');
}

/**
 * Export loans to CSV
 */
function exportLoansToCSV() {
    const yearData = tracker.getYearData();
    
    if (!yearData.loans || yearData.loans.length === 0) {
        showToast('No loan data to export', 'error');
        return;
    }
    
    let csv = `${tracker.currentYear} Loans\n\n`;
    
    yearData.loans.forEach((loan, index) => {
        csv += `Loan: ${loan.loanPaidTo || 'Loan ' + (index + 1)}\n`;
        csv += `Lender: ${loan.loanLender || 'N/A'}\n`;
        csv += `Account #: ${loan.accountNumber || 'N/A'}\n`;
        csv += `Loan #: ${loan.loanNumber || 'N/A'}\n`;
        csv += `Due Date: ${loan.dueDate || 'N/A'}\n`;
        csv += `Regular Payment: ${loan.regularPayment || 0}\n`;
        csv += `Original Amount: ${loan.originalAmount || 0}\n`;
        csv += `Interest Rate: ${loan.interestRate || 0}%\n`;
        csv += `Notes: ${loan.notes || ''}\n`;
        csv += '\nMonth,Payment Dates,Payment Amounts,Balance Post-Pay\n';
        
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                        'July', 'August', 'September', 'October', 'November', 'December'];
        const monthKeys = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        
        monthKeys.forEach((key, i) => {
            const log = loan.log?.[key] || {};
            const dates = (log.paymentDates || []).join('; ');
            const amounts = (log.paymentAmounts || []).map(a => '$' + a.toFixed(2)).join('; ');
            const balance = log.balancePostPay || 0;
            
            csv += `${months[i]},${dates},${amounts},${balance.toFixed(2)}\n`;
        });
        
        csv += '\n\n';
    });
    
    downloadCSV(csv, `Finance_Tracker_Loans_${tracker.currentYear}.csv`);
    showToast('Loans exported to CSV!', 'success');
}

/**
 * Export subscriptions to CSV
 */
function exportSubscriptionsToCSV() {
    const yearData = tracker.getYearData();
    
    if (!yearData.subscriptions || yearData.subscriptions.length === 0) {
        showToast('No subscription data to export', 'error');
        return;
    }
    
    let csv = `${tracker.currentYear} Subscriptions\n\n`;
    csv += 'Date of Payment,Subscription,Renewal,Purpose,Charge,Per Cycle,Annual Total,Monthly Total,Payment Method,Order #,Registration #,Link,Email,Notes\n';
    
    yearData.subscriptions.forEach(sub => {
        const purposes = Array.isArray(sub.purpose) ? sub.purpose.join('; ') : (sub.purpose || '');
        
        csv += `${sub.dateOfPayment || ''},`;
        csv += `"${sub.subscriptionTo || ''}",`;
        csv += `${sub.renewal || ''},`;
        csv += `"${purposes}",`;
        csv += `${sub.charge || 0},`;
        csv += `${sub.perCycle || 0},`;
        csv += `${sub.annualTotal || 0},`;
        csv += `${sub.monthlyTotal || 0},`;
        csv += `${sub.paymentMethod || ''},`;
        csv += `${sub.orderNumber || ''},`;
        csv += `${sub.registrationNumber || ''},`;
        csv += `"${sub.link || ''}",`;
        csv += `${sub.email || ''},`;
        csv += `"${sub.notes || ''}"\n`;
    });
    
    downloadCSV(csv, `Finance_Tracker_Subscriptions_${tracker.currentYear}.csv`);
    showToast('Subscriptions exported to CSV!', 'success');
}

/**
 * Export all data to CSV (comprehensive export)
 */
function exportAllToCSV() {
    exportMonthlyToCSV();
    
    setTimeout(() => {
        exportCreditToCSV();
    }, 100);
    
    setTimeout(() => {
        exportLoansToCSV();
    }, 200);
    
    setTimeout(() => {
        exportSubscriptionsToCSV();
    }, 300);
    
    showToast('All data exported! Check your downloads folder.', 'success');
}

/**
 * Helper function to download CSV
 */
function downloadCSV(csvContent, filename) {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    
    if (navigator.msSaveBlob) {
        // IE 10+
        navigator.msSaveBlob(blob, filename);
    } else {
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
}

/**
 * Add export button to each view
 */
function addExportButtons() {
    // Monthly view
    const monthlyControls = document.querySelector('#monthlyView .table-controls');
    if (monthlyControls && !document.getElementById('exportMonthlyBtn')) {
        const exportBtn = document.createElement('button');
        exportBtn.id = 'exportMonthlyBtn';
        exportBtn.className = 'btn-secondary';
        exportBtn.innerHTML = '📊 Export to CSV';
        exportBtn.onclick = exportMonthlyToCSV;
        monthlyControls.appendChild(exportBtn);
    }
    
    // Credit view
    const creditControls = document.querySelector('#creditView .table-controls');
    if (creditControls && !document.getElementById('exportCreditBtn')) {
        const exportBtn = document.createElement('button');
        exportBtn.id = 'exportCreditBtn';
        exportBtn.className = 'btn-secondary';
        exportBtn.innerHTML = '📊 Export to CSV';
        exportBtn.onclick = exportCreditToCSV;
        creditControls.appendChild(exportBtn);
    }
    
    // Loans view
    const loansControls = document.querySelector('#loansView .table-controls');
    if (loansControls && !document.getElementById('exportLoansBtn')) {
        const exportBtn = document.createElement('button');
        exportBtn.id = 'exportLoansBtn';
        exportBtn.className = 'btn-secondary';
        exportBtn.innerHTML = '📊 Export to CSV';
        exportBtn.onclick = exportLoansToCSV;
        loansControls.appendChild(exportBtn);
    }
    
    // Subscriptions view
    const subsControls = document.querySelector('#subscriptionsView .table-controls');
    if (subsControls && !document.getElementById('exportSubscriptionsBtn')) {
        const exportBtn = document.createElement('button');
        exportBtn.id = 'exportSubscriptionsBtn';
        exportBtn.className = 'btn-secondary';
        exportBtn.innerHTML = '📊 Export to CSV';
        exportBtn.onclick = exportSubscriptionsToCSV;
        subsControls.appendChild(exportBtn);
    }
}

// Add export buttons after DOM loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(addExportButtons, 500);
    });
} else {
    setTimeout(addExportButtons, 500);
}

// Add "Export All" button to settings
setTimeout(() => {
    const dataSection = document.querySelector('.data-io-section');
    if (dataSection && !document.getElementById('exportAllCSVBtn')) {
        const exportAllBtn = document.createElement('button');
        exportAllBtn.id = 'exportAllCSVBtn';
        exportAllBtn.className = 'btn-primary';
        exportAllBtn.style.marginTop = '1rem';
        exportAllBtn.innerHTML = '📊 Export All to CSV';
        exportAllBtn.onclick = exportAllToCSV;
        
        const h4 = dataSection.querySelector('h4');
        if (h4) {
            h4.insertAdjacentElement('afterend', exportAllBtn);
        }
    }
}, 1000);

console.log('✅ Phase 3: CSV Export Module Loaded');
