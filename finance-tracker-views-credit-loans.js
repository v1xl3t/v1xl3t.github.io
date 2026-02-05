// Credit & Loans Views v2.0

function renderCreditView() {
    const container = document.getElementById('creditTableContainer');
    if (!container) return;
    
    const cards = tracker.data.creditCards || [];
    
    if (cards.length === 0) {
        container.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-secondary)">No credit cards added yet</div>';
        return;
    }
    
    let html = '<table class="data-table"><thead><tr><th>Name</th><th>Limit</th><th>Balance</th><th>APR</th><th>Actions</th></tr></thead><tbody>';
    
    cards.forEach(card => {
        html += `<tr>
            <td>${card.name}</td>
            <td>$${(card.limit || 0).toLocaleString()}</td>
            <td>$${(card.balance || 0).toLocaleString()}</td>
            <td>${card.apr || 0}%</td>
            <td><button class="btn-small" onclick="editCard('${card.id}')">Edit</button></td>
        </tr>`;
    });
    
    html += '</tbody></table>';
    container.innerHTML = html;
}

function renderLoansView() {
    const container = document.getElementById('loansTableContainer');
    if (!container) return;
    
    const loans = tracker.data.loans || [];
    
    if (loans.length === 0) {
        container.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-secondary)">No loans added yet</div>';
        return;
    }
    
    let html = '<table class="data-table"><thead><tr><th>Name</th><th>Amount</th><th>Remaining</th><th>Rate</th><th>Payment</th><th>Actions</th></tr></thead><tbody>';
    
    loans.forEach(loan => {
        html += `<tr>
            <td>${loan.name}</td>
            <td>$${(loan.originalAmount || 0).toLocaleString()}</td>
            <td>$${(loan.remainingBalance || 0).toLocaleString()}</td>
            <td>${loan.interestRate || 0}%</td>
            <td>$${(loan.monthlyPayment || 0).toLocaleString()}</td>
            <td><button class="btn-small" onclick="editLoan('${loan.id}')">Edit</button></td>
        </tr>`;
    });
    
    html += '</tbody></table>';
    container.innerHTML = html;
}

function addCreditCard() {
    const name = prompt('Card name:');
    if (!name) return;
    
    tracker.saveState();
    tracker.data.creditCards.push({
        id: 'card_' + Date.now(),
        name: name,
        limit: 0,
        balance: 0,
        apr: 0,
        dueDate: 1,
        closingDate: 1
    });
    
    renderCreditView();
}

function addLoan() {
    const name = prompt('Loan name:');
    if (!name) return;
    
    tracker.saveState();
    tracker.data.loans.push({
        id: 'loan_' + Date.now(),
        name: name,
        originalAmount: 0,
        remainingBalance: 0,
        interestRate: 0,
        monthlyPayment: 0,
        dueDate: 1
    });
    
    renderLoansView();
}

function editCard(id) {
    alert('Edit modal coming soon');
}

function editLoan(id) {
    alert('Edit modal coming soon');
}

document.addEventListener('DOMContentLoaded', function() {
    const addCreditBtn = document.getElementById('addCreditCard');
    const addLoanBtn = document.getElementById('addLoan');
    
    if (addCreditBtn) {
        addCreditBtn.addEventListener('click', addCreditCard);
    }
    
    if (addLoanBtn) {
        addLoanBtn.addEventListener('click', addLoan);
    }
});

console.log('Credit/Loans views loaded');

// Edit functions with basic prompts
function editCard(id) {
    const card = tracker.data.creditCards.find(c => c.id === id);
    if (!card) return;
    
    const limit = prompt('Credit limit:', card.limit);
    const balance = prompt('Current balance:', card.balance);
    const apr = prompt('APR (%):', card.apr);
    
    if (limit !== null) {
        tracker.saveState();
        card.limit = parseFloat(limit) || 0;
        card.balance = parseFloat(balance) || 0;
        card.apr = parseFloat(apr) || 0;
        renderCreditView();
    }
}

function editLoan(id) {
    const loan = tracker.data.loans.find(l => l.id === id);
    if (!loan) return;
    
    const amount = prompt('Original amount:', loan.originalAmount);
    const remaining = prompt('Remaining balance:', loan.remainingBalance);
    const rate = prompt('Interest rate (%):', loan.interestRate);
    const payment = prompt('Monthly payment:', loan.monthlyPayment);
    
    if (amount !== null) {
        tracker.saveState();
        loan.originalAmount = parseFloat(amount) || 0;
        loan.remainingBalance = parseFloat(remaining) || 0;
        loan.interestRate = parseFloat(rate) || 0;
        loan.monthlyPayment = parseFloat(payment) || 0;
        renderLoansView();
    }
}
