// ===================================
// FINANCE TRACKER - PART 2A
// Dashboard & Monthly View Rendering
// ===================================

// ===================================
// QUICK ACTIONS
// ===================================

/**
 * Quick add income
 */
function quickAddIncome() {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                        'July', 'August', 'September', 'October', 'November', 'December'];
    const currentMonth = new Date().getMonth();
    
    const categories = tracker.data.categories.income;
    let categoryOptions = '';
    categories.forEach(cat => {
        categoryOptions += `<option value="${cat.id}">${cat.name}</option>`;
    });
    
    showModal(`
        <h2>Add Income</h2>
        <form id="quickIncomeForm" style="display: flex; flex-direction: column; gap: 1rem;">
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Category:</label>
                <select id="incomeCategory" required style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                        border: 1px solid var(--border-color); background: var(--bg-primary); 
                        color: var(--text-primary);">
                    ${categoryOptions}
                </select>
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Month:</label>
                <select id="incomeMonth" style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                        border: 1px solid var(--border-color); background: var(--bg-primary); 
                        color: var(--text-primary);">
                    ${months.map((m, i) => `<option value="${m}" ${i === currentMonth ? 'selected' : ''}>${monthNames[i]}</option>`).join('')}
                </select>
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Amount:</label>
                <input type="number" step="0.01" id="incomeAmount" placeholder="0.00" required
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div style="display: flex; gap: 1rem;">
                <button type="submit" class="btn-primary">Add Income</button>
                <button type="button" class="btn-secondary" onclick="closeModal()">Cancel</button>
            </div>
        </form>
    `);
    
    document.getElementById('quickIncomeForm').addEventListener('submit', (e) => {
        e.preventDefault();
        
        const category = document.getElementById('incomeCategory').value;
        const month = document.getElementById('incomeMonth').value;
        const amount = parseFloat(document.getElementById('incomeAmount').value) || 0;
        
        tracker.saveState();
        const yearData = tracker.getYearData();
        yearData.monthly.moneyIn[month][category] = 
            (yearData.monthly.moneyIn[month][category] || 0) + amount;
        
        tracker.calculateMonthlyTotals(month);
        
        closeModal();
        renderDashboard();
        showToast(`Added ${formatCurrency(amount)} to income!`, 'success');
    });
}

/**
 * Quick add expense
 */
function quickAddExpense() {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                        'July', 'August', 'September', 'October', 'November', 'December'];
    const currentMonth = new Date().getMonth();
    
    const categories = tracker.data.categories.spending;
    let categoryOptions = '<option value="savings">Savings</option>';
    categories.forEach(cat => {
        categoryOptions += `<option value="${cat.id}">${cat.name}</option>`;
    });
    
    showModal(`
        <h2>Add Expense</h2>
        <form id="quickExpenseForm" style="display: flex; flex-direction: column; gap: 1rem;">
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Category:</label>
                <select id="expenseCategory" required style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                        border: 1px solid var(--border-color); background: var(--bg-primary); 
                        color: var(--text-primary);">
                    ${categoryOptions}
                </select>
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Month:</label>
                <select id="expenseMonth" style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                        border: 1px solid var(--border-color); background: var(--bg-primary); 
                        color: var(--text-primary);">
                    ${months.map((m, i) => `<option value="${m}" ${i === currentMonth ? 'selected' : ''}>${monthNames[i]}</option>`).join('')}
                </select>
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Amount:</label>
                <input type="number" step="0.01" id="expenseAmount" placeholder="0.00" required
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div style="display: flex; gap: 1rem;">
                <button type="submit" class="btn-primary">Add Expense</button>
                <button type="button" class="btn-secondary" onclick="closeModal()">Cancel</button>
            </div>
        </form>
    `);
    
    document.getElementById('quickExpenseForm').addEventListener('submit', (e) => {
        e.preventDefault();
        
        const category = document.getElementById('expenseCategory').value;
        const month = document.getElementById('expenseMonth').value;
        const amount = parseFloat(document.getElementById('expenseAmount').value) || 0;
        
        tracker.saveState();
        const yearData = tracker.getYearData();
        yearData.monthly.moneyOut[month][category] = 
            (yearData.monthly.moneyOut[month][category] || 0) + amount;
        
        tracker.calculateMonthlyTotals(month);
        
        closeModal();
        renderDashboard();
        showToast(`Added ${formatCurrency(amount)} to expenses!`, 'success');
    });
}

/**
 * Quick pay credit card
 */
function quickPayCredit() {
    const yearData = tracker.getYearData();
    
    if (!yearData.credit || yearData.credit.length === 0) {
        showToast('Please add a credit card first', 'info');
        switchView('credit');
        return;
    }
    
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                        'July', 'August', 'September', 'October', 'November', 'December'];
    const currentMonth = new Date().getMonth();
    
    let cardOptions = '';
    yearData.credit.forEach((card, i) => {
        cardOptions += `<option value="${i}">${card.name || 'Card ' + (i + 1)}</option>`;
    });
    
    showModal(`
        <h2>Log Credit Payment</h2>
        <form id="quickCreditForm" style="display: flex; flex-direction: column; gap: 1rem;">
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Credit Card:</label>
                <select id="creditCard" required style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                        border: 1px solid var(--border-color); background: var(--bg-primary); 
                        color: var(--text-primary);">
                    ${cardOptions}
                </select>
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Month:</label>
                <select id="creditMonth" style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                        border: 1px solid var(--border-color); background: var(--bg-primary); 
                        color: var(--text-primary);">
                    ${months.map((m, i) => `<option value="${m}" ${i === currentMonth ? 'selected' : ''}>${monthNames[i]}</option>`).join('')}
                </select>
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Payment Amount:</label>
                <input type="number" step="0.01" id="creditAmount" placeholder="0.00" required
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div style="display: flex; gap: 1rem;">
                <button type="submit" class="btn-primary">Log Payment</button>
                <button type="button" class="btn-secondary" onclick="closeModal()">Cancel</button>
            </div>
        </form>
    `);
    
    document.getElementById('quickCreditForm').addEventListener('submit', (e) => {
        e.preventDefault();
        
        const cardIndex = parseInt(document.getElementById('creditCard').value);
        const month = document.getElementById('creditMonth').value;
        const amount = parseFloat(document.getElementById('creditAmount').value) || 0;
        
        tracker.saveState();
        
        if (!yearData.credit[cardIndex].log[month]) {
            yearData.credit[cardIndex].log[month] = { paymentDates: [], paymentAmounts: [] };
        }
        
        if (!yearData.credit[cardIndex].log[month].paymentAmounts) {
            yearData.credit[cardIndex].log[month].paymentAmounts = [];
        }
        
        yearData.credit[cardIndex].log[month].paymentAmounts.push(amount);
        
        syncCreditDataToMonthly(month, yearData);
        tracker.calculateMonthlyTotals(month);
        
        closeModal();
        renderDashboard();
        showToast(`Logged ${formatCurrency(amount)} payment!`, 'success');
    });
}

/**
 * Quick pay loan
 */
function quickPayLoan() {
    const yearData = tracker.getYearData();
    
    if (!yearData.loans || yearData.loans.length === 0) {
        showToast('Please add a loan first', 'info');
        switchView('loans');
        return;
    }
    
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                        'July', 'August', 'September', 'October', 'November', 'December'];
    const currentMonth = new Date().getMonth();
    
    let loanOptions = '';
    yearData.loans.forEach((loan, i) => {
        loanOptions += `<option value="${i}">${loan.loanPaidTo || 'Loan ' + (i + 1)}</option>`;
    });
    
    showModal(`
        <h2>Log Loan Payment</h2>
        <form id="quickLoanForm" style="display: flex; flex-direction: column; gap: 1rem;">
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Loan:</label>
                <select id="loanSelect" required style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                        border: 1px solid var(--border-color); background: var(--bg-primary); 
                        color: var(--text-primary);">
                    ${loanOptions}
                </select>
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Month:</label>
                <select id="loanMonth" style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                        border: 1px solid var(--border-color); background: var(--bg-primary); 
                        color: var(--text-primary);">
                    ${months.map((m, i) => `<option value="${m}" ${i === currentMonth ? 'selected' : ''}>${monthNames[i]}</option>`).join('')}
                </select>
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Payment Amount:</label>
                <input type="number" step="0.01" id="loanAmount" placeholder="0.00" required
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div style="display: flex; gap: 1rem;">
                <button type="submit" class="btn-primary">Log Payment</button>
                <button type="button" class="btn-secondary" onclick="closeModal()">Cancel</button>
            </div>
        </form>
    `);
    
    document.getElementById('quickLoanForm').addEventListener('submit', (e) => {
        e.preventDefault();
        
        const loanIndex = parseInt(document.getElementById('loanSelect').value);
        const month = document.getElementById('loanMonth').value;
        const amount = parseFloat(document.getElementById('loanAmount').value) || 0;
        
        tracker.saveState();
        
        if (!yearData.loans[loanIndex].log[month]) {
            yearData.loans[loanIndex].log[month] = { paymentDates: [], paymentAmounts: [] };
        }
        
        if (!yearData.loans[loanIndex].log[month].paymentAmounts) {
            yearData.loans[loanIndex].log[month].paymentAmounts = [];
        }
        
        yearData.loans[loanIndex].log[month].paymentAmounts.push(amount);
        
        syncLoanDataToMonthly(month, yearData);
        tracker.calculateMonthlyTotals(month);
        
        closeModal();
        renderDashboard();
        showToast(`Logged ${formatCurrency(amount)} payment!`, 'success');
    });
}

// ===================================
// DASHBOARD RENDERING
// ===================================
function renderDashboard() {
    const yearData = tracker.getYearData();
    const currentMonth = new Date().getMonth(); // 0-11
    const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const currentMonthKey = monthNames[currentMonth];
    const prevMonthKey = currentMonth > 0 ? monthNames[currentMonth - 1] : null;

    // Get current month data
    const moneyIn = yearData.monthly.moneyIn[currentMonthKey];
    const debt = yearData.monthly.debt[currentMonthKey];
    const moneyOut = yearData.monthly.moneyOut[currentMonthKey];

    // Calculate totals
    tracker.calculateMonthlyTotals(currentMonthKey);
    if (prevMonthKey) {
        tracker.calculateMonthlyTotals(prevMonthKey);
    }

    // Calculate changes
    const incomeChange = prevMonthKey ? 
        moneyIn.total - yearData.monthly.moneyIn[prevMonthKey].total : 0;
    const debtChange = prevMonthKey ? 
        debt.total - yearData.monthly.debt[prevMonthKey].total : 0;
    const spendingChange = prevMonthKey ? 
        moneyOut.total - yearData.monthly.moneyOut[prevMonthKey].total : 0;

    // Update stat cards
    document.getElementById('dashTotalIncome').textContent = formatCurrency(moneyIn.total);
    document.getElementById('dashTotalDebt').textContent = formatCurrency(debt.total);
    document.getElementById('dashTotalSpending').textContent = formatCurrency(moneyOut.total);
    document.getElementById('dashNetFlow').textContent = formatCurrency(moneyIn.total - moneyOut.total);

    // Update change indicators
    updateChangeIndicator('dashIncomeChange', incomeChange);
    updateChangeIndicator('dashDebtChange', debtChange);
    updateChangeIndicator('dashSpendingChange', spendingChange);

    // Render chart (simplified for now - we'll add a proper chart library later)
    renderDashboardChart();
}

function updateChangeIndicator(elementId, change) {
    const element = document.getElementById(elementId);
    const prefix = change >= 0 ? '+' : '';
    element.textContent = `${prefix}${formatCurrency(change)} from last month`;
    
    element.classList.remove('positive', 'negative');
    if (elementId === 'dashDebtChange' || elementId === 'dashSpendingChange') {
        // For debt and spending, negative is good
        element.classList.add(change <= 0 ? 'positive' : 'negative');
    } else {
        // For income, positive is good
        element.classList.add(change >= 0 ? 'positive' : 'negative');
    }
}

function renderDashboardChart() {
    // Placeholder for chart - we'll implement with canvas or chart library
    const canvas = document.getElementById('dashboardChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const yearData = tracker.getYearData();
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    
    // Get last 6 months of data
    const currentMonth = new Date().getMonth();
    const startMonth = Math.max(0, currentMonth - 5);
    const displayMonths = months.slice(startMonth, currentMonth + 1);

    // Simple bar chart representation
    canvas.width = canvas.offsetWidth;
    canvas.height = 300;

    const barWidth = canvas.width / (displayMonths.length * 2 + 1);
    const maxValue = Math.max(
        ...displayMonths.map(m => yearData.monthly.moneyIn[m].total),
        ...displayMonths.map(m => yearData.monthly.moneyOut[m].total)
    );

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    displayMonths.forEach((month, i) => {
        const income = yearData.monthly.moneyIn[month].total;
        const spending = yearData.monthly.moneyOut[month].total;

        const incomeHeight = maxValue > 0 ? (income / maxValue) * (canvas.height - 40) : 0;
        const spendingHeight = maxValue > 0 ? (spending / maxValue) * (canvas.height - 40) : 0;

        const x = (i * 2 + 1) * barWidth;

        // Income bar (blue)
        ctx.fillStyle = '#4f46e5';
        ctx.fillRect(x, canvas.height - incomeHeight - 20, barWidth * 0.8, incomeHeight);

        // Spending bar (purple)
        ctx.fillStyle = '#7c3aed';
        ctx.fillRect(x + barWidth, canvas.height - spendingHeight - 20, barWidth * 0.8, spendingHeight);

        // Month label
        ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-secondary');
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(month.toUpperCase(), x + barWidth, canvas.height - 5);
    });
}

// ===================================
// MONTHLY VIEW RENDERING
// ===================================
function renderMonthlyView() {
    const yearData = tracker.getYearData();
    const tbody = document.getElementById('monthlyTableBody');
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

    // Calculate all monthly totals first
    months.forEach(month => tracker.calculateMonthlyTotals(month));

    tbody.innerHTML = '';

    // SAVINGS row (new addition)
    const savingsRow = createMonthlyRow('Savings', 'savings', 'moneyOut', months, yearData, false);
    tbody.appendChild(savingsRow);

    // MONEY IN section
    const moneyInHeader = createCategoryHeader('MONEY IN', 'moneyIn');
    tbody.appendChild(moneyInHeader);

    const moneyInRow = createMonthlyRow('Total Money In', 'total', 'moneyIn', months, yearData, true, 'total-row');
    tbody.appendChild(moneyInRow);

    // Money IN subcategories
    const incomeCategories = [
        { label: 'Work Income', key: 'workIncome' },
        { label: 'Secondary Income', key: 'secondaryIncome' },
        { label: 'Other Income', key: 'otherIncome' }
    ];

    incomeCategories.forEach(cat => {
        const row = createMonthlyRow(cat.label, cat.key, 'moneyIn', months, yearData, false, 'subcategory-row');
        tbody.appendChild(row);
    });

    // Shift row for Money IN
    const moneyInShift = createShiftRow('Shift', 'moneyIn', months, yearData);
    tbody.appendChild(moneyInShift);

    // DEBT section
    const debtHeader = createCategoryHeader('DEBT', 'debt');
    tbody.appendChild(debtHeader);

    const debtRow = createMonthlyRow('Total Debt', 'total', 'debt', months, yearData, true, 'total-row');
    tbody.appendChild(debtRow);

    // Debt subcategories
    const debtCategories = [
        { label: 'Loan Balance', key: 'loanBalance' },
        { label: 'Credit Balance', key: 'creditBalance' }
    ];

    debtCategories.forEach(cat => {
        const row = createMonthlyRow(cat.label, cat.key, 'debt', months, yearData, false, 'subcategory-row');
        tbody.appendChild(row);
    });

    // Shift row for Debt
    const debtShift = createShiftRow('Shift', 'debt', months, yearData);
    tbody.appendChild(debtShift);

    // MONEY OUT section
    const moneyOutHeader = createCategoryHeader('MONEY OUT', 'moneyOut');
    tbody.appendChild(moneyOutHeader);

    const moneyOutRow = createMonthlyRow('Total Money Out', 'total', 'moneyOut', months, yearData, true, 'total-row');
    tbody.appendChild(moneyOutRow);

    // Money OUT subcategories
    const spendingCategories = [
        { label: 'Credit Payments', key: 'creditPayments' },
        { label: 'Loan Payments', key: 'loanPayments' },
        { label: 'Other Spending', key: 'otherSpending' },
        { label: 'Subscriptions', key: 'subscriptions' },
        { label: 'Cost of Living', key: 'costOfLiving' }
    ];

    spendingCategories.forEach(cat => {
        const row = createMonthlyRow(cat.label, cat.key, 'moneyOut', months, yearData, false, 'subcategory-row');
        tbody.appendChild(row);
    });

    // Shift row for Money OUT
    const moneyOutShift = createShiftRow('Shift', 'moneyOut', months, yearData);
    tbody.appendChild(moneyOutShift);

    // NOTES section
    const notesHeader = createCategoryHeader('NOTES', 'notes');
    tbody.appendChild(notesHeader);

    const notesRow = createNotesRow(months, yearData);
    tbody.appendChild(notesRow);
}

function createCategoryHeader(title, categoryId) {
    const row = document.createElement('tr');
    row.className = 'category-header-row';
    row.style.background = 'var(--bg-secondary)';
    row.style.fontWeight = 'bold';
    row.innerHTML = `
        <td class="sticky-col" colspan="13" style="padding: 1rem;">
            <span style="cursor: pointer;" onclick="toggleCategoryExpand('${categoryId}')">
                ▼ ${title}
            </span>
        </td>
    `;
    return row;
}

function createMonthlyRow(label, dataKey, category, months, yearData, isTotal = false, className = '') {
    const row = document.createElement('tr');
    row.className = className;
    row.dataset.category = category;

    // Determine if this field is auto-calculated
    const autoCalcFields = ['creditPayments', 'loanPayments', 'subscriptions', 'creditBalance', 'loanBalance'];
    const isAutoCalc = autoCalcFields.includes(dataKey);

    if (isTotal) {
        row.style.fontWeight = 'bold';
        row.style.background = 'var(--bg-secondary)';
    }

    let html = `<td class="sticky-col">
        ${label}
        ${isAutoCalc ? '<span style="color: var(--accent-primary); font-size: 0.75rem; margin-left: 0.5rem;" title="Auto-calculated from Credit/Loans/Subscriptions">🔄</span>' : ''}
    </td>`;

    months.forEach(month => {
        const value = yearData.monthly[category][month][dataKey] || 0;
        const formattedValue = formatCurrency(value);
        const cellId = `${category}-${dataKey}-${month}`;
        
        html += `
            <td>
                <input 
                    type="number" 
                    step="0.01" 
                    value="${value}"
                    data-category="${category}"
                    data-key="${dataKey}"
                    data-month="${month}"
                    onchange="updateMonthlyValue(this)"
                    style="width: 100%; border: 1px solid var(--border-color); 
                           background: ${isAutoCalc ? 'var(--bg-tertiary)' : 'var(--bg-primary)'}; 
                           color: ${isAutoCalc ? 'var(--text-secondary)' : 'var(--text-primary)'};
                           padding: 0.5rem; border-radius: 6px;"
                    ${isTotal || isAutoCalc ? 'readonly' : ''}
                    title="${isAutoCalc ? 'Auto-calculated from ' + (dataKey === 'creditPayments' || dataKey === 'creditBalance' ? 'Credit Cards' : dataKey === 'loanPayments' || dataKey === 'loanBalance' ? 'Loans' : 'Subscriptions') : ''}"
                />
            </td>
        `;
    });

    row.innerHTML = html;
    return row;
}

function createShiftRow(label, category, months, yearData) {
    const row = document.createElement('tr');
    row.className = 'shift-row';
    row.style.color = 'var(--text-secondary)';
    row.style.fontStyle = 'italic';
    row.dataset.category = category;

    let html = `<td class="sticky-col">${label}</td>`;

    months.forEach((month, index) => {
        const shift = index === 0 ? 0 : tracker.calculateShift(category, month);
        const formattedShift = formatCurrency(shift);
        const colorClass = shift >= 0 ? 'positive' : 'negative';
        
        html += `<td class="${colorClass}">${formattedShift}</td>`;
    });

    row.innerHTML = html;
    return row;
}

function createNotesRow(months, yearData) {
    const row = document.createElement('tr');
    row.className = 'notes-row';

    let html = `<td class="sticky-col">Notes</td>`;

    months.forEach(month => {
        const note = yearData.monthly.notes[month] || '';
        
        html += `
            <td>
                <textarea 
                    data-month="${month}"
                    onchange="updateMonthlyNote(this)"
                    style="width: 100%; min-height: 60px; border: 1px solid var(--border-color); 
                           background: var(--bg-primary); color: var(--text-primary);
                           padding: 0.5rem; border-radius: 6px; resize: vertical;"
                    placeholder="Add notes..."
                >${note}</textarea>
            </td>
        `;
    });

    row.innerHTML = html;
    return row;
}

function updateMonthlyValue(input) {
    const category = input.dataset.category;
    const key = input.dataset.key;
    const month = input.dataset.month;
    const value = parseFloat(input.value) || 0;

    tracker.saveState();
    
    const yearData = tracker.getYearData();
    yearData.monthly[category][month][key] = value;

    // Recalculate totals
    tracker.calculateMonthlyTotals(month);

    // Re-render to update totals and shifts
    renderMonthlyView();
    
    showToast('Updated successfully', 'success');
}

function updateMonthlyNote(textarea) {
    const month = textarea.dataset.month;
    const note = textarea.value;

    tracker.saveState();
    
    const yearData = tracker.getYearData();
    yearData.monthly.notes[month] = note;
    
    showToast('Note saved', 'success');
}

function toggleCategoryExpand(categoryId) {
    const rows = document.querySelectorAll(`tr[data-category="${categoryId}"]`);
    rows.forEach(row => {
        if (!row.classList.contains('category-header-row')) {
            row.style.display = row.style.display === 'none' ? '' : 'none';
        }
    });
}

// Set up expand/collapse all buttons
document.getElementById('expandAllMonthly')?.addEventListener('click', () => {
    document.querySelectorAll('#monthlyTableBody tr').forEach(row => {
        row.style.display = '';
    });
});

document.getElementById('collapseAllMonthly')?.addEventListener('click', () => {
    document.querySelectorAll('#monthlyTableBody tr').forEach(row => {
        if (row.classList.contains('subcategory-row') || 
            row.classList.contains('shift-row') || 
            row.classList.contains('notes-row')) {
            row.style.display = 'none';
        }
    });
});

// Add custom category functionality
document.getElementById('addMonthlyCategory')?.addEventListener('click', () => {
    showModal(`
        <h2>Add Custom Category</h2>
        <form id="addCategoryForm">
            <div style="margin-bottom: 1rem;">
                <label style="display: block; margin-bottom: 0.5rem;">Category Section:</label>
                <select id="categorySection" style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                        border: 1px solid var(--border-color); background: var(--bg-primary); 
                        color: var(--text-primary);">
                    <option value="moneyIn">Money IN</option>
                    <option value="moneyOut">Money OUT</option>
                </select>
            </div>
            <div style="margin-bottom: 1rem;">
                <label style="display: block; margin-bottom: 0.5rem;">Category Name:</label>
                <input type="text" id="categoryName" placeholder="e.g., Freelance Income" 
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                       border: 1px solid var(--border-color); background: var(--bg-primary); 
                       color: var(--text-primary);">
            </div>
            <div style="display: flex; gap: 1rem;">
                <button type="submit" class="btn-primary">Add Category</button>
                <button type="button" class="btn-secondary" onclick="closeModal()">Cancel</button>
            </div>
        </form>
    `);

    document.getElementById('addCategoryForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const section = document.getElementById('categorySection').value;
        const name = document.getElementById('categoryName').value.trim();
        
        if (!name) {
            showToast('Please enter a category name', 'error');
            return;
        }

        // Add to data structure (simplified - would need full implementation)
        showToast('Custom categories coming in Phase 2!', 'info');
        closeModal();
    });
});
