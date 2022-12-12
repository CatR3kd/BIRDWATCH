const express = require('express');
const app = require('express')();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');
const { fetch } = require('undici');
const Filter = require('bad-words');
filter = new Filter(); // The filter code is slightly modified by me
const { RateLimiterMemory } = require('rate-limiter-flexible');
const { QuickDB } = require("quick.db");
const db = new QuickDB({filePath: "Data/db.sqlite"});
const connectedPlayers = new Map();
const busyPlayers = new Map();

// Make sure map is good and present
validateMap();

// Get leaderboard
let leaderboard = getLeaderboard();

class Game{
	constructor(){
    this.money = 0;
    this.speed = 1;
    this.damage = 15;
    this.health = 100;
    this.maxHealth = 100;
    this.location = 'spawnpoint';
  	this.items = [];
    this.alliances = [];
    this.defeatedEnemies = [];
  }
}


// Ratelimiter

const sendChatRateLimit = new RateLimiterMemory({
  points: 4,
  duration: 2
});


// Server

http.listen(8000, () => {
  console.log('Server online');
});

app.get('/map',function(req,res) {
  res.sendFile(path.join(__dirname + '/Map/map.json'));
});

app.use(express.static(path.join(__dirname + '/Public')));


// Socket.io

io.on('connection', (socket) => {
  // Set up and login/create account
  (async function(){
    const username = socket.handshake.headers['x-replit-user-name'];
    
    if((!username) || (connectedPlayers.has(username))){
      socket.disconnect();
    } else {
      let user = await db.get(username);
  
      if(user == undefined) user = await createAccount(username);

      connectedPlayers.set(username, socket.id);
  
      socket.emit('loggedIn', user);
      socket.emit('leaderboard', leaderboard);
    }
  })();

  socket.on('action', function(actionObj) {
    const username = socket.handshake.headers['x-replit-user-name'];
    
    playAction(username, socket, actionObj);
  });

  socket.on('sendChat', async function(msg) {
    const username = socket.handshake.headers['x-replit-user-name'];
    const userid = socket.handshake.headers['x-replit-user-id']
    
    try {
      await sendChatRateLimit.consume(username);
      
      sendChat(username, msg, socket);
    } catch(rejRes) {
      // Ratelimited
      systemMessage(socket.id, 'Slow down!');
    }
  });

  socket.on('disconnect', function() {
    const username = socket.handshake.headers['x-replit-user-name'];
    
    if(connectedPlayers.has(username)){
      connectedPlayers.delete(username);
    }
  });
});


// Accounts

async function createAccount(username){
  const userObj = {
    username: username,
    game: new Game(),
    banStatus: false
  }

  await db.set(username, userObj);
  return userObj;
}


// Map

function validateMap(){
  const map = JSON.parse(fs.readFileSync('Map/map.json'));
  const backup = JSON.parse(fs.readFileSync('Map/backup.json'));

  if(isEmpty('Map/map.json') && !(isEmpty('Map/backup.json'))){
    fs.writeFileSync('Map/map.json', JSON.stringify(backup));
  }

  if(!(isEmpty('Map/map.json')) && isEmpty('Map/backup.json')){
    fs.writeFileSync('Map/backup.json', JSON.stringify(map));
  }

  if(isEmpty('Map/map.json') && isEmpty('Map/backup.json')){
    console.log('Map files are empty.');
  }
}

function isEmpty(path) {
  const file = fs.readFileSync(path);
  for(var key in file) {
    if(file.hasOwnProperty(key) && Object.keys(JSON.parse(file)).length !== 0)
      return false;
    }
  return true;
}

// Game


async function playAction(username, socket, actionObj){
  // Make sure user exists and isn't busy
  const user = await db.get(username);
  if(user == undefined) return;
  
  const busy = busyPlayers.get(user.username);
  if(busy != undefined) return socket.emit('message', `You cannot use this command while ${busy}.`);

  const command = (actionObj.command).toLowerCase();
  const args = (actionObj.args).map(elem => {
    return elem.toLowerCase();
  });

  // Get new, untouched map
  const gameMap = JSON.parse(fs.readFileSync('Map/map.json'));
  
  if(command == 'move'){
    // Moving system
    const destinationName = gameMap[user.game.location].neighbors[args[0]];
    const destination = gameMap[destinationName];
    if(destination == undefined) return socket.emit('message', 'That is not an available action.');

    // Check if the user is allowed in the target destination based on items, alliances, and enemies
    let cannotPass = false;
    
    for(let item of destination.neededToEnter){
      if(!(user.game.items.includes(item))){
        cannotPass = true;
        return socket.emit('message', `You need the "${item}" to pass!`);
      }
    }

    if(cannotPass == true) return;

    for(let bannedAlliance of destination.bannedAlliances){
      if(user.game.alliances.includes(bannedAlliance)){
        cannotPass = true;
        return socket.emit('message', `You cannot enter this zone because it does not allow people with the ${bannedAlliance} alliance!`);
      }
    }
    
    if(cannotPass == true) return;

    for(let neededAlliance of destination.neededAlliances){
      if(!(user.game.alliances.includes(neededAlliance))){
        cannotPass = true;
        return socket.emit('message', `You cannot enter this zone because it only allows people with the ${neededAlliance} alliance!`);
      }
    }
    
    if(cannotPass == true) return;

    const currentLocation = gameMap[user.game.location];
    
    for(let enemyID in currentLocation.enemies){
      const enemy = currentLocation.enemies[enemyID];
      
      if((!(user.game.defeatedEnemies.includes(enemy.name))) && (enemy.blockedDirection == args[0])){
        cannotPass = true;
        return socket.emit('message', `Before you can move to the ${args[0]}, you must defeat the ${enemyID}! ("fight ${enemyID}")`);
      }
    }
    
    if(cannotPass == true) return;
    
    let newUser = user;
    newUser.game.location = destinationName;
    await db.set(username, newUser);
    
    return socket.emit('gameUpdate', {"user": newUser, "notify": true});
  } else if(command == 'talk'){
    // NPC Interaction system
    const availableNPCs = gameMap[user.game.location].npcs;
    const targetNPC = availableNPCs[args[0]];

    if(targetNPC == undefined) return socket.emit('message', 'That is not an available action.');

    return socket.emit('message', `${targetNPC.name}: ${targetNPC.text}`);
  } else if(command == 'fight'){
    // Fighting system
    const targetEnemy = gameMap[user.game.location].enemies[args[0]];
    
    if(targetEnemy == undefined) return socket.emit('message', 'That is not an available action.');

      if(user.game.defeatedEnemies.includes(targetEnemy.name)) return socket.emit('message', 'That is not an available action. (You have already beaten this enemy!)');

    busyPlayers.set(user.username, 'fighting');
    let nextTurn = (user.game.speed >= targetEnemy.stats.speed)? 'user' : 'enemy';

    const fightInterval = setInterval(function(){
      if(nextTurn == 'user'){
        targetEnemy.stats.health -= user.game.damage;
        socket.emit('message', `You attacked the ${targetEnemy.name} and dealt ${user.game.damage} damage.`);
        nextTurn = 'enemy';
      } else { // else instead of elseif is lost redundancy and potentially bad
        user.game.health -= targetEnemy.stats.damage;
        socket.emit('message', `The ${targetEnemy.name} attacked you and dealt ${targetEnemy.stats.damage} damage.`);
        nextTurn = 'user';
      }

      socket.emit('gameUpdate', {"user": user, "notify": false});
      socket.emit('message', `Your health: ${(user.game.health > 0)? user.game.health : 0}/${user.game.maxHealth}\nEnemy health:${(targetEnemy.stats.health > 0)? targetEnemy.stats.health : 0}/${targetEnemy.stats.maxHealth}`);
      
      if((user.game.health <= 0) || (targetEnemy.stats.health <= 0)){
        let newUser = user;
        
        if(user.game.health > 0){
          // Fight won
          newUser.game.defeatedEnemies.push(targetEnemy.name);
          
          socket.emit('message', `You beat the ${targetEnemy.name}!`);
        } else {
          // Fight lost
          newUser.game.location = 'spawnpoint';
          newUser.game.money = Math.floor(user.game.money / 2);
          newUser.game.health = user.game.maxHealth;

          socket.emit('message', 'You died and lost half of your money. You\'ve respawned at the world spawnpoint.');
        }

        db.set(username, newUser);
        socket.emit('gameUpdate', {"user": newUser, "notify": true});
        busyPlayers.delete(user.username);
        
        clearInterval(fightInterval);
      }
    }, 1000);
  } else if((command == 'buy') || (command == 'inspect')){
    const currentLocation = gameMap[user.game.location];
    
    // Buying and inspecting items
    let targetItem;

    // Find item in the wares of nearby NPC's
    Object.keys(currentLocation.npcs).forEach(function(key){
      const npc = currentLocation.npcs[key];
      const item = npc.wares[args[0]];
      
      if(item != undefined) targetItem = item;
    });
    
    const item = targetItem;
    
    if(item == undefined) return socket.emit('message', 'That is not an available action.');

    // Inspect
    if(command == 'inspect'){
      return socket.emit('message', `${item.name}: ${item.description}\nPrice: $${item.price}`);
    }

    // Buy
    // Make sure user doesn't already have the item
    if(user.game.items.includes(item.name)) return socket.emit('message', 'You already own this item!');
    
    // Make sure user has enough money
    if(user.game.money < item.price) return socket.emit('message', 'You don\'t have enough money to buy this item.');

    let newUser = user;
    newUser.game.money -= item.price;
    newUser.game.items.push(item.name);

    // Change player stats
    if(item.type == 'weapon'){
      newUser.game.damage += item.damage;
    }

    if(item.type == 'armor'){
      newUser.game.maxHealth += item.defense;
      newUser.game.health += item.defense;
    }

    if(item.type == 'speed'){
      newUser.game.speed += item.speed;
    }

    await db.set(username, newUser);

    socket.emit('message', `You purchased the ${item.name}!`);
    return socket.emit('gameUpdate', {"user": newUser, "notify": false});
  } else if(command == 'mine'){
    // Mining
    if((user.game.location != 'mine') && (user.game.location != 'platinumMine')) return socket.emit('message', 'That is not an available action.');

    const ore = (user.game.location == 'platinumMine')? 'platinum' : 'gold';
    const oreValue = (ore == 'platinum')? 75 : 50;

    // Change stats based on user items and ore type
    let mineTime = 1000;
    if(user.game.items.includes('SuperPick')) mineTime = 650;

    let multiplier = 10;
    if(user.game.items.includes('SuperDetector')) multiplier = 12.5;

    if(ore == 'platinum'){
      mineTime += 125;
      multiplier -= 0.5;
    }
    
    let counter = 0;

    socket.emit('message', `Mining... (${counter * 10}%)`);
    busyPlayers.set(user.username, 'mining');
    
    const mineInterval = setInterval(function(){
      counter++;
      socket.emit('message', `Mining... (${counter * 10}%)`);

      // Notify and profit when completed
      if(counter >= 10){
        const oreFound = Math.floor(Math.random() * Math.random() * multiplier);
        const punctuation = (oreFound > 0)? '!' : '.';
        const grams = (oreFound != 1)? 'grams' : 'gram';
        
        socket.emit('message', `Finished${punctuation} Found ${oreFound} ${grams} of ${ore}${punctuation} (Earned: $${oreFound * oreValue})`);

        // Save profit
        let newUser = user;

        newUser.game.money += (oreFound * oreValue);
        
        db.set(username, newUser);
        socket.emit('gameUpdate', {"user": newUser, "notify": false});

        busyPlayers.delete(user.username);
        clearInterval(mineInterval);
      }
    }, mineTime);
  } else if(commaned == 'train'){
    // Training
    if(user.game.location != 'gym') return socket.emit('message', 'That is not an available action.');
    if(user.game.money < 20) return socket.emit('message', 'You don\'t have enough money!');

    let newUser = user;
    newUser.game.money -= 20;

    let counter = 0;
    const trainTime = (user.game.items.includes('Supplements'))? 450 : 500;
    
    socket.emit('message', `Training... (${counter * 10}%)`);
    busyPlayers.set(user.username, 'training');
    
    const trainInterval = setInterval(function(){
      counter++;
      socket.emit('message', `Training... (${counter * 10}%)`);
      if(counter >= 10){
        const multiplier = (user.game.items.includes('Supplements'))? 5 : 4; 
        const damageGained = Math.floor(Math.random() * multiplier);
        const speedGained = Math.floor(Math.random() * multiplier);
        const punctuation = ((damageGained + speedGained) > 0)? '!' : '.';
        
        socket.emit('message', `Finished${punctuation} Damage stat increased by ${damageGained}, speed stats increase by ${speedGained}${punctuation}`);

        // Save gainz
        newUser.game.damage += damageGained;
        newUser.game.speed += speedGained;
        
        db.set(username, newUser);
        socket.emit('gameUpdate', {"user": newUser, "notify": false});

        busyPlayers.delete(user.username);
        clearInterval(trainInterval);
      }
    }, trainTime);
  } else if(commaned == 'battle'){
    // Battling
    if(user.game.location != 'camp') return socket.emit('message', 'That is not an available action.');

    const enemy = {
      name: "Opposing Brawler",
      stats: {
        speed: (Math.floor(Math.random() * 3) + 1),
        health: ((Math.floor(Math.random() * 2) + 1) * 50),
        damage: ((Math.floor(Math.random() * 5) + 1) * 5)
      }
    }
    
    busyPlayers.set(user.username, 'fighting');
    let nextTurn = (user.game.speed >= enemy.stats.speed)? 'user' : 'enemy';

    const fightInterval = setInterval(function(){
      if(nextTurn == 'user'){
        enemy.stats.health -= user.game.damage;
        socket.emit('message', `You attacked the ${enemy.name} and dealt ${user.game.damage} damage.`);
        nextTurn = 'enemy';
      } else { // else instead of elseif is lost redundancy and potentially bad
        user.game.health -= enemy.stats.damage;
        socket.emit('message', `The ${enemy.name} attacked you and dealt ${enemy.stats.damage} damage.`);
        nextTurn = 'user';
      }

      socket.emit('gameUpdate', {"user": user, "notify": false});
      socket.emit('message', `Your health: ${(user.game.health > 0)? user.game.health : 0}/${user.game.maxHealth}\nEnemy health:${(enemy.stats.health > 0)? enemy.stats.health : 0}/${enemy.stats.maxHealth}`);
      
      if((user.game.health <= 0) || (enemy.stats.health <= 0)){
        let newUser = user;
        
        if(user.game.health > 0){
          // Fight won
          socket.emit('message', `You beat the ${enemy.name} and gained $75!`);
          newUser.game.money += 75;
        } else {
          // Fight lost
          socket.emit('message', `You lost to the ${enemy.name}.`);
        }

        db.set(username, newUser);
        socket.emit('gameUpdate', {"user": newUser, "notify": true});
        busyPlayers.delete(user.username);
        
        clearInterval(fightInterval);
      }
    }, 500);
    
  } else if(command == 'heal'){
    // Healing
    if(user.game.location != 'fountain') return socket.emit('message', 'That is not an available action.');
    if(user.game.money < 5) return socket.emit('message', 'You don\'t have enough money.');

    // Get amount of HP to heal, and cost
    let HPToHeal = (user.game.maxHealth - user.game.health);

    if(HPToHeal <= 0) return socket.emit('message', 'You are already at full health!');

    if(user.game.money < (HPToHeal * 5)) HPToHeal = Math.floor(user.game.money / 5);
    const price = (HPToHeal * 5);
    let newUser = user;
    newUser.game.money -= price;
    newUser.game.health += HPToHeal;
    
    // Save user and update the client
    await db.set(username, newUser);
    
    socket.emit('gameUpdate', {"user": newUser, "notify": false});

    // Emit message
    socket.emit('message', `Bizarre Squirrel: [The squirrel looks up at you, and fear wells up in your stomach. You have no idea what to expect, until it jumps up and licks you, covering you in slime. Almost immediately, you pass out.]\n\nYou wake up, and the squirrel is exactly where it was before it attacked you.\nHP Healed: ${HPToHeal} (Current HP: ${newUser.game.health}/${newUser.game.maxHealth})\nMoney spent: $${price}`);
  } else if(command == 'ally'){
    // Ally system
    if(!gameMap[user.game.location].availableAlliances.includes(args[0])) return socket.emit('message', 'That is not an available action.');
    
    const targetAlly = args[0];

    if(user.game.alliances.includes(targetAlly)) return socket.emit('message', 'You are already in this alliance!');

    const allianceEnemies = {
      "penguin": ["pigeon"],
      "pigeon": ["penguin"]
    }

    let enemy = false;

    for(let alliance of user.game.alliances){
      if(allianceEnemies[targetAlly].includes(alliance)) return enemy = true;
    }

    if(enemy == true) return socket.emit('message', 'You are already in an opposing alliance!');

    let newUser = user;
    newUser.game.alliances.push(targetAlly);

    await db.set(username, newUser);

    socket.emit('gameUpdate', {"user": newUser, "notify": false});
    socket.emit('message', `Joined the ${targetAlly} alliance!`);
  } else if(command == 'eat'){
    // Eating system
    if(!user.game.items.includes(capitalizeFirstLetter(args[0]))) return socket.emit('message', 'That is not an available action.');
    
    const food = {
      "sandwich":30,
      "cake":200
    }
    const healAmount = food[args[0]];
    
    if(healAmount == undefined) return socket.emit('message', 'That is not an available action.');

    if(user.game.health <= user.game.maxHealth) return socket.emit('message', 'You are already at full health!');

    let oldHealth = user.health;
    let newUser = user;
    
    const foodIndex = newUser.game.items.indexOf(capitalizeFirstLetter(args[0]));
    
    if(foodIndex == -1) return socket.emit('message', 'That is not an available action.');
    
    newUser.game.items.splice(foodIndex, 1);
    newUser.game.health += healAmount;
    if(newUser.game.health > newUser.game.maxHealth) newUser.game.health = newUser.game.maxHealth;
    
    await db.set(username, newUser);
    
    socket.emit('gameUpdate', {"user": newUser, "notify": false});
    return socket.emit('message', `Healed ${newUser.game.health - oldHealth} HP by eating the ${capitalizeFirstLetter(args[0])}!`);
  } else if(command == 'spawn'){
    // Porter
    if(!user.game.items.includes('Porter')) return socket.emit('message', 'That is not an available action.');

    let newUser = user;
    newUser.game.location = 'spawnpoint';

    await db.set(username, newUser);
    
    socket.emit('gameUpdate', {"user": newUser, "notify": true});
  } else {
    // Unrecognized command
    return socket.emit('message', 'That is not an available action.');
  }
}


// Chat

async function sendChat(username, msg, socket){
  if((msg.charAt(0) == '/') && (username === 'CatR3kd')) return chatCommand(msg, socket.id);
  if((msg.length < 1) || (msg.length > 199)) return;

  const user = await db.get(username);

  if(user.banStatus == true) return systemMessage(socket.id, 'You are currently banned from using the chat function.');

  let badgeColor = '#D1D1CD';
  let title = '';

  if(username == topTipper){
    badgeColor = '#0fa7ff';
    title += '[#1 Supporter] ';
  } else if(tippers.includes(username)){
    badgeColor = '#5b8dd9';
    title += '[Supporter] ';
  }
  
  if((leaderboard.length > 2) && (username == leaderboard[2].username)){
    badgeColor = '#e59e57';
    title += '[#3] ';
  }
  
  if((leaderboard.length > 1) && (username == leaderboard[1].username)){
    badgeColor = '#ababab';
    title += '[#2] ';
  }
  
  if((leaderboard.length > 0) && (username == leaderboard[0].username)){
    badgeColor = '#E9D675';
    title += '[#1] ';
  }
  
  if(username == 'CatR3kd'){
    badgeColor = '#9792E3';
    title += '[Dev] ';
  }

  const msgObj = {
    sender: `${title}${username}`,
    msg: filter.clean(msg),
    badgeColor: badgeColor
  }
    
  io.emit('chatMsg', msgObj);
}

async function chatCommand(msg, socketID){
  const command = msg.split(' ')[0].substring(1).toLowerCase();
  let args = msg.split(' ');
  args.shift();

  //Help
  if(command == 'help'){
    return systemMessage(socketID, '\n/kick {user}: Refreshes a specified user\'s page\n/warn {user} {message}: Warns a specified user with a given message\n/ban {user}: Bans a specified user from sending chat messages\n/unban {user}: Unbans a specified user from sending chat messages');
  }

  // Kick
  if(command == 'kick'){
    if(args[0] == 'CatR3kd') return systemMessage(socketID, 'Cannot kick this user!');
    
    const targetSocket = await connectedPlayers.get(args[0]);
    if(targetSocket == undefined) return systemMessage(socketID, 'User not found.');

    io.to(targetSocket).emit('kicked');
    return systemMessage(socketID, `Kicked user ${args[0]}.`);
  }

  if(command == 'warn'){
    const targetSocket = await connectedPlayers.get(args[0]);
    if(targetSocket == undefined) return systemMessage(socketID, 'User not found.');
    if(args[1] == undefined) return systemMessage(socketID, 'You need to provide a warning message');

    return systemMessage(targetSocket, `An admin has warned you: ${args[1]}`);
  }

  // Ban
  if(command == 'ban'){
    if(args[0] == 'CatR3kd') return systemMessage(socketID, 'Cannot ban this user!');
    
    const targetUser = await db.get(args[0]);
    if(targetUser == undefined) return systemMessage(socketID, 'User not found.');

    const newUser = targetUser;
    newUser.banStatus = true;

    await db.set(args[0], newUser);

    systemMessage(socketID, `Banned user ${args[0]}.`);

    const targetSocket = await connectedPlayers.get(args[0]);
    if(targetSocket != undefined) systemMessage(targetSocket, 'An admin has banned you from using the chat.');
    
    return;
  }

  // Unban
  if(command == 'unban'){
    const targetUser = await db.get(args[0]);
    if(targetUser == undefined) return systemMessage(socketID, 'User not found.');

    const newUser = targetUser;
    newUser.banStatus = false;

    await db.set(args[0], newUser);

    systemMessage(socketID, `Unbanned user ${args[0]}.`);

    const targetSocket = await connectedPlayers.get(args[0]);
    if(targetSocket != undefined) systemMessage(targetSocket, 'An admin has unbanned you from using the chat!');
    
    return;
  }

  return systemMessage(socketID, 'Command not recognized.');
}

function systemMessage(socketID, msg){
  const chatObj = {
    sender: 'System',
    msg: msg,
    badgeColor: '#F45B69'
  }
      
  io.to(socketID).emit('chatMsg', chatObj);
}


// Leaderboard

async function getLeaderboard(){
  const all = await db.all();
  all.sort(function (a, b) {
    return b.value.game.money - a.value.game.money;
  });
  
  const topTen = all.slice(0, 10);
  let leaderboard = [];

  for(let user of topTen){
    const userObj = {
      username: user.value.username,
      money: user.value.game.money
    }

    leaderboard.push(userObj);
  }

  return leaderboard;
}

setInterval(async function(){
  leaderboard = await getLeaderboard();
  io.emit('leaderboard', leaderboard);
}, 5000);

// Misc.


function capitalizeFirstLetter(word){
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// Replit tip system
// NOTE TO SELF: If I ever want to remove this, just remove the code in the chat badge function, the tipping code below, and uninstall and remove the declration for undici/fetch

let tippers = [];
let topTipper = '';

async function updateTips(){
  await fetch('https://catr3kd-tip-api.catr3kd.repl.co/all?replId=64cefdf4-f0a7-4643-a002-1423cf53324a', {method: 'GET'})
  .then(r => r.json().then(res => {
  	tippers = (res.users || []);
  })).catch((error) => {
    console.error(error);
  });
  await fetch('https://catr3kd-tip-api.catr3kd.repl.co/top?replId=64cefdf4-f0a7-4643-a002-1423cf53324a', {method: 'GET'})
  .then(r => r.json().then(res => {
  	topTipper = (res.topTipper || '');
  })).catch((error) => {
    console.error(error);
  });
}

updateTips();
setInterval(updateTips, 10_000);