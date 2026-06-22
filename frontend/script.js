const API_BASE_URL = 'http://localhost:3000/api';
let socket = null;
let currentUser = null;
let activePolls = [];
let votedPolls = new Set();

window.pollCharts = {};

// --- ЗВУК ---
let soundEnabled = false;
let voteAudio = null;

function initAudio() {
    voteAudio = document.getElementById('voteAudio');
    if (voteAudio) {
        voteAudio.volume = 0;
        voteAudio.play().then(() => {
            soundEnabled = true;
            voteAudio.pause();
            voteAudio.currentTime = 0;
            voteAudio.volume = 1;
            const warning = document.getElementById('soundWarning');
            if (warning) warning.style.display = 'none';
        }).catch(() => {
            const warning = document.getElementById('soundWarning');
            if (warning) {
                warning.style.display = 'block';
                warning.onclick = function() {
                    if (voteAudio) {
                        voteAudio.play().then(() => {
                            voteAudio.pause();
                            voteAudio.currentTime = 0;
                            soundEnabled = true;
                            warning.style.display = 'none';
                            alert('Звук включён!');
                        }).catch(() => {});
                    }
                };
            }
        });
    }
}

function playVoteSound() {
    if (!soundEnabled || !voteAudio) return;
    try {
        voteAudio.currentTime = 0;
        voteAudio.play().catch(e => console.log('Звук:', e));
    } catch(e) {
        console.log('Ошибка звука:', e);
    }
}

// --- WEBSOCKET ---

function initWebSocket() {
    try {
        socket = io('http://localhost:3000/');

        socket.on('connect', () => {
            console.log('WebSocket подключен');
            updateConnectionStatus(true);
        });

        socket.on('disconnect', () => {
            console.log('WebSocket отключен');
            updateConnectionStatus(false);
        });

        socket.on('vote_update', (data) => {
            updatePollResults(data.pollId, data.results);
            playVoteSound();
        });

        socket.on('poll_started', (poll) => {
            addActivePoll(poll);
        });

        socket.on('poll_ended', (pollId) => {
            removeActivePoll(pollId);
        });
    } catch (e) {
        console.error("Ошибка Socket.io", e);
    }
}

// --- ГРАФИКИ ---

function initOrUpdateChart(pollId, results, options) {
    const ctx = document.getElementById(`chart-${pollId}`);
    if (!ctx) return;

    const labels = options.map(o => o.text);
    const votes = results.map(r => r.vote_count);
    const type = options.length <= 4 ? 'pie' : 'bar';

    if (window.pollCharts[pollId]) {
        window.pollCharts[pollId].data.datasets[0].data = votes;
        window.pollCharts[pollId].update();
    } else {
        window.pollCharts[pollId] = new Chart(ctx, {
            type: type,
            data: {
                labels: labels,
                datasets: [{
                    data: votes,
                    backgroundColor: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#8bc34a', '#f44336'],
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: type === 'pie', position: 'bottom' }
                },
                scales: type === 'bar' ? { y: { beginAtZero: true, ticks: { stepSize: 1 } } } : {}
            }
        });
    }
}

// --- АВТОРИЗАЦИЯ ---

function checkSavedSession() {
    const saved = localStorage.getItem('poll_user');
    if (saved) {
        try {
            currentUser = JSON.parse(saved);
        } catch (e) {
            localStorage.removeItem('poll_user');
        }
    }
}

function logout() {
    localStorage.removeItem('poll_user');
    location.href = 'index.html';
}

function showUserInterface() {
    const userInfo = document.getElementById('userInfo');
    if (userInfo && currentUser) {
        userInfo.textContent = `${currentUser.role === 'admin' ? 'Админ' : 'Юзер'}: ${currentUser.username}`;
        userInfo.classList.remove('hidden');
    }
    document.getElementById('logoutBtn')?.classList.remove('hidden');
    document.getElementById('userProfileBtn')?.classList.remove('hidden');
    if (currentUser && currentUser.role === 'admin') {
        document.getElementById('adminPanelBtn')?.classList.remove('hidden');
    }
    ['adminLoginBtn', 'userLoginBtn', 'userRegisterBtn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.add('hidden');
    });
}

// --- ОПРОСЫ ---

async function loadActivePolls() {
    try {
        const response = await fetch(`${API_BASE_URL}/polls/active`);
        const data = await response.json();
        if (data.success) {
            activePolls = data.polls;
            displayActivePolls(data.polls);
        }
    } catch (error) { console.error(error); }
}

function displayActivePolls(polls) {
    const pollsList = document.getElementById('activePollsList');
    if (!pollsList) return;
    pollsList.innerHTML = polls.length === 0 ? '<p>Нет опросов</p>' : '';

    polls.forEach(poll => {
        const pollElement = createPollElement(poll);
        pollsList.appendChild(pollElement);
        loadPollResults(poll.id);
    });
}

function createPollElement(poll) {
    const pollElement = document.createElement('div');
    pollElement.className = 'poll-item';
    pollElement.dataset.pollId = poll.id;
    pollElement.style.cssText = "background:#fff; border:1px solid #ddd; margin:10px 0; padding:15px; border-radius:10px; color:#333;";

    const alreadyVoted = votedPolls.has(poll.id);

    const optionsHtml = poll.options.map(opt => `
        <div class="poll-option" data-option-id="${opt.id}" 
             style="padding:10px; margin:5px 0; background:#f0f2f5; border-radius:6px; cursor:${alreadyVoted ? 'default' : 'pointer'}; display:flex; justify-content:space-between;">
            <span>${opt.text}</span>
            <span class="vote-count" style="font-weight:bold; color:#007bff;">0</span>
        </div>`
    ).join('');

    pollElement.innerHTML = `
        <div style="font-weight:bold; margin-bottom:10px;">${poll.question}</div>
        <div class="poll-options">${optionsHtml}</div>
        <div style="height: 180px; margin-top: 15px;">
            <canvas id="chart-${poll.id}"></canvas>
        </div>
    `;

    if (!alreadyVoted) {
        pollElement.querySelectorAll('.poll-option').forEach(el => {
            el.onclick = () => sendVote(poll.id, el.dataset.optionId);
        });
    }
    return pollElement;
}

async function sendVote(pollId, optionId) {
    if (votedPolls.has(pollId)) return;
    const userSessionId = currentUser ? `user_${currentUser.id}` : `anon_${Math.random().toString(36).substr(2, 9)}`;

    try {
        const response = await fetch(`${API_BASE_URL}/votes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ optionId, userSessionId }),
        });
        const data = await response.json();
        if (data.success) {
            votedPolls.add(pollId);
            const el = document.querySelector(`[data-poll-id="${pollId}"]`);
            if (el) el.querySelectorAll('.poll-option').forEach(opt => opt.style.cursor = 'default');
        } else { alert(data.error); }
    } catch (error) { console.error(error); }
}

async function loadPollResults(pollId) {
    try {
        const response = await fetch(`${API_BASE_URL}/polls/${pollId}/results`);
        const data = await response.json();
        if (data.success) updatePollResults(pollId, data.results);
    } catch (error) { console.error(error); }
}

function updatePollResults(pollId, results) {
    const pollElement = document.querySelector(`.poll-item[data-poll-id="${pollId}"]`);
    if (!pollElement) return;

    results.forEach((res) => {
        const countEl = pollElement.querySelector(`[data-option-id="${res.id}"] .vote-count`);
        if (countEl) countEl.textContent = res.vote_count;
    });

    const poll = activePolls.find(p => p.id == pollId);
    if (poll) initOrUpdateChart(pollId, results, poll.options);
}

function updateConnectionStatus(connected) {
    const el = document.getElementById('pollStatus');
    if (el) {
        el.textContent = connected ? '● В эфире' : '○ Оффлайн';
        el.style.color = connected ? '#28a745' : '#dc3545';
    }
}

function addActivePoll(poll) {
    if (document.querySelector(`[data-poll-id="${poll.id}"]`)) return;
    activePolls.push(poll);
    const pollsList = document.getElementById('activePollsList');
    if (pollsList) pollsList.prepend(createPollElement(poll));
}

function removeActivePoll(pollId) {
    activePolls = activePolls.filter(p => p.id != pollId);
    const el = document.querySelector(`[data-poll-id="${pollId}"]`);
    if (el) {
        el.style.opacity = '0.5';
        el.style.pointerEvents = 'none';
    }
    if (window.pollCharts[pollId]) {
        window.pollCharts[pollId].destroy();
        delete window.pollCharts[pollId];
    }
}
