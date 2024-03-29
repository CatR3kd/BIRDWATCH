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
const raidScores = new QuickDB({filePath: "Data/raids.sqlite"});
const airdrops = new QuickDB({filePath: "Data/airdrops.sqlite"});
const connectedPlayers = new Map();
const busyPlayers = new Map();
const raidingPlayers = new Map();
const blackjackGames = new Map();
const battleQueue = new Map();
const resetRequests = new Map();
const prestigeRequests = new Map();



// Get leaderboard
let leaderboard = getLeaderboard();

class Game{
	constructor(){
    this.money = 0;
    this.level = 1;
    this.highestLevel = 1;
    this.prestige = 0;
    this.xp = 0;
    this.xpRequired = xpRequired(this.level);
    this.speed = 1;
    this.speedBuff = 0;
    this.damage = 15;
    this.damageBuff = 0;
    this.health = 100;
    this.maxHealth = 100;
    this.maxHealthBuff = 0;
    this.location = 'spawnpoint';
  	this.items = [];
    this.alliance = '';
    this.defeatedEnemies = [];
    this.discoveredLocations = ['spawnpoint'];
    this.completedQuests = [];
    this.claimedQuests = [];
    this.food = 0;
    this.lastDailyReward = 0;
    this.lastElixir = 0;
  }
}



// Ratelimiter

const sendChatRateLimit = new RateLimiterMemory({
  points: 3,
  duration: 2
});

const commandRateLimit = new RateLimiterMemory({
  points: 5,
  duration: 2
});


// Server

http.listen(8000, () => {
  console.log('Server online');
});

app.get('/map',function(req,res) {
  res.sendFile(path.join(__dirname + '/Data/map.json'));
});

app.use(express.static(path.join(__dirname + '/Public')));


// Socket.io

io.on('connection', (socket) => {
  // Emit supporter list
  socket.emit('supporters', tippers);
  
  // Set up and login/create account
  (async function(){
    const username = socket.handshake.headers['x-replit-user-name'];
    
    // Check that there is a username header set
    if(!username){
      return socket.disconnect();
    }

    // Delete existing connection
    if(connectedPlayers.has(username)){
      const connectedSocket = io.sockets.sockets.get(connectedPlayers.get(username));
      
      connectedSocket.emit('loginError', 'You logged in somewhere else, so this tab was disconnected. Please reload!');
      connectedSocket.disconnect();
      connectedPlayers.delete(username);

      socket.emit('loginError', 'You were already logged in somewhere else, so that tab was disconnected.');
    }
    
    let user = await db.get(username);
    if(!user) user = await createAccount(username);

    connectedPlayers.set(username, socket.id);

    if(user.game.location == 'prestigeHall') socket.join('Prestige Hall');
  
    socket.emit('loggedIn', user);
    socket.emit('leaderboard', leaderboard);
    
    io.emit('playerCount', connectedPlayers.size);
  })();

  socket.on('action', async function(actionObj) {
    try{
      const username = socket.handshake.headers['x-replit-user-name'];
      
      await commandRateLimit.consume(username);
      
      playAction(username, socket, actionObj);
    } catch(rejRes) {
      // Ratelimited
      return socket.emit('message', 'Slow down!');
    }
  });

  socket.on('sendChat', async function(msg) {
    const username = socket.handshake.headers['x-replit-user-name'];
    const userid = socket.handshake.headers['x-replit-user-id'];
    
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
      io.emit('playerCount', connectedPlayers.size);
    }

    if(raidingPlayers.has(username)){
      raidingPlayers.delete(username);
      busyPlayers.delete(username);
    }

    const blackjackGame = blackjackGames.get(username);
    if(blackjackGame != undefined)  blackjackGame.end();

    if(battleQueue.has(username)){
      battleQueue.delete(username);
      busyPlayers.delete(username);
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


// Misc. game data

const savedMap = JSON.parse(fs.readFileSync('Data/map.json'));
const quests = JSON.parse(fs.readFileSync('Data/quests.json'));
const raidMap = JSON.parse(fs.readFileSync('Data/raids.json'));
const food = {
  sandwich: 30,
  cake: 200,
  birdseed: 10
}


// Game

async function playAction(username, socket, actionObj){
  // Make sure user exists and isn't busy
  const user = await db.get(username);
  if(!user) return;

  const command = (actionObj.command).toLowerCase();

  // Only make args lowercase for case-insensitive commands
  const caseSensitiveCommands = ['playerinfo'];
  let args;
  
  if(caseSensitiveCommands.includes(command)){
    args = actionObj.args;
  } else {
    args = (actionObj.args).map(elem => {
      return elem.toLowerCase();
    });
  }

  const busy = busyPlayers.get(user.username);
  const busyWhitelist = ['option', 'leave'];

  // Make sure user is not busy, with the exception of a few commands
  if((busy != undefined) && (!busyWhitelist.includes(command))) return socket.emit('message', `You cannot use this command while ${busy}.`);

  // Create a clone of the map to prevent overwriting it on accident
  const gameMap = JSON.parse(JSON.stringify(savedMap));
  
  if(command == 'move'){
    // Moving system
    const destinationName = gameMap[user.game.location].neighbors[args[0]];
    const destination = gameMap[destinationName];
    if(!destination) return socket.emit('message', 'That is not an available action.');

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
      if(user.game.alliance == bannedAlliance){
        cannotPass = true;
        return socket.emit('message', `You cannot enter this zone because it does not allow members of the the ${bannedAlliance} alliance!`);
      }
    }
    
    if(cannotPass == true) return;

    for(let neededAlliance of destination.neededAlliances){
      if(user.game.alliance != neededAlliance){
        cannotPass = true;
        return socket.emit('message', `You cannot enter this zone because it only allows members of the ${neededAlliance} alliance!`);
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

    // Nighttime hollow time check
    if((destinationName == 'hollow') && (actionObj.hour < 20)) return socket.emit('message', 'The trees are pointing up towards the sun and block your path. Maybe if you come back later you can get through...');

    // Prestige hall level check
    if((destinationName == 'prestigeHall') && (user.game.highestLevel < 100)) return socket.emit('message', 'You walk to the doors of the hall and push as hard as you can, but they don\'t budge. Perhaps you should come back once you\'re more powerful...');

    let newUser = user;

    // Manny's Midnight Market quest
    if((destinationName == 'hollow') && (!user.game.completedQuests.includes('midnightmarket'))){
      newUser.game.completedQuests.push('midnightmarket');
      socket.emit('message', '(You feel as though you\'ve completed something important, maybe you should check the quest board!)');
    }

    // Prestige hall Socket.IO room
    if(destinationName == 'prestigeHall'){
      socket.join('Prestige Hall');
    } else if (socket.rooms.has('Prestige Hall')){
      socket.leave('Prestige Hall');
    }
    
    newUser.game.location = destinationName;
    if(!newUser.game.discoveredLocations.includes(destinationName)) newUser.game.discoveredLocations.push(destinationName);
    
    await db.set(user.username, newUser);
    
    return socket.emit('gameUpdate', {"user": newUser, "notify": true});
  } else if(command == 'talk'){
    // NPC Interaction system
    const availableNPCs = gameMap[user.game.location].npcs;
    const targetNPC = availableNPCs[args[0]];

    if(!targetNPC) return socket.emit('message', 'That is not an available action.');

    return socket.emit('message', `${targetNPC.name}: ${targetNPC.text}`);
  } else if(command == 'fight'){
    // Fighting system
    const targetEnemy = gameMap[user.game.location].enemies[args[0]];
    
    if(!targetEnemy) return socket.emit('message', 'That is not an available action.');

      if(user.game.defeatedEnemies.includes(targetEnemy.name)) return socket.emit('message', 'That is not an available action. (You have already beaten this enemy!)');

    busyPlayers.set(user.username, 'fighting');
    let nextTurn = ((user.game.speed + user.game.speedBuff) >= targetEnemy.stats.speed)? 'user' : 'enemy';

    const fightInterval = setInterval(function(){
      if(nextTurn == 'user'){
        targetEnemy.stats.health -= (user.game.damage + user.game.damageBuff);
        socket.emit('message', `You attacked the ${targetEnemy.name} and dealt ${user.game.damage + user.game.damageBuff} damage.`);
        nextTurn = 'enemy';
      } else {
        user.game.health -= targetEnemy.stats.damage;
        socket.emit('message', `The ${targetEnemy.name} attacked you and dealt ${targetEnemy.stats.damage} damage.`);
        nextTurn = 'user';
      }

      socket.emit('gameUpdate', {"user": user, "notify": false});
      socket.emit('message', `Your health: ${(user.game.health > 0)? user.game.health : 0}/${user.game.maxHealth}\nEnemy health: ${(targetEnemy.stats.health > 0)? targetEnemy.stats.health : 0}/${targetEnemy.stats.maxHealth}`);
      
      if((user.game.health <= 0) || (targetEnemy.stats.health <= 0)){
        let newUser = user;
        let xpMultiplier;
        
        if(user.game.health > 0){
          // Fight won
          newUser.game.defeatedEnemies.push(targetEnemy.name);

          // Bounty hunter quest
          if(!user.game.completedQuests.includes('bountyhunter')) user.game.completedQuests.push('bountyhunter');

          xpMultiplier = 1.2;
          
          socket.emit('message', `You beat the ${targetEnemy.name}!`);
        } else {
          // Fight lost
          newUser.game.location = 'spawnpoint';
          const moneyLost = (user.game.items.includes('Companion'))? 0 : Math.floor(user.game.money / 2);
          newUser.game.money -= moneyLost;
          newUser.game.health = user.game.maxHealth;

          xpMultiplier = 0.15;

          socket.emit('message', `You died and lost $${formatNumber(moneyLost)}. You've respawned at the world spawnpoint.`);
        }

        const xpGained = 35 * (Math.random() + 1) * xpMultiplier;
        newUser = addXP(newUser, xpGained, socket);

        db.set(user.username, newUser);
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
    for(key of Object.keys(currentLocation.npcs)){
      const npc = currentLocation.npcs[key];
      const item = npc.wares[args[0]];
      
      if(item != undefined) targetItem = item;
    };
    
    const item = targetItem;
    
    if(!item) return socket.emit('message', 'That is not an available action.');

    // Inspect
    if(command == 'inspect'){
      return socket.emit('message', `${item.name}: ${item.description}\nPrice: $${formatNumber(item.price)}`);
    }

    // Buy
    // Make sure user doesn't already have the item
    if(user.game.items.includes(item.name)) return socket.emit('message', 'You already own this item!');
    
    // Make sure user has enough money
    const price = (user.game.items.includes('Companion'))? (item.price * 9 / 10) : item.price;
    if(user.game.money < price) return socket.emit('message', 'You don\'t have enough money to buy this item.');

    let newUser = user;
    newUser.game.money -= price;

    // Apply elixir
    if(item.name == 'Elixir'){
      newUser.game.lastElixir = Date.now();
      
      await db.set(user.username, newUser);

      socket.emit('message', `You purchased the ${item.name}, your buffs will remain for the next 45 minutes!`);
      return socket.emit('gameUpdate', {"user": newUser, "notify": false});
    }
    
    if(user.game.items.includes('Pouch') && (item.type == 'food')){
      // Check if the player is buying food and has the pouch and/or microwave
      newUser.game.food += (food[item.name.toLowerCase()]  * ((user.game.items.includes('Microwave'))? 1.5 : 1));
    } else {
      newUser.game.items.push(item.name);
    }

    // Change player stats
    if(item.type == 'weapon'){
      newUser.game.damageBuff += item.damage;
    }

    if(item.type == 'armor'){
      newUser.game.maxHealthBuff += item.defense;
      newUser.game.health += item.defense;
    }

    if(item.type == 'speed'){
      newUser.game.speedBuff += item.speed;
    }

    // Convert food if player bought the pouch
    if(item.name == 'Pouch'){
      for(let item in user.game.items){
        const current = food[user.game.items[item].toLowerCase()];
        
        if(current != undefined){
          user.game.items.splice(item, 1);

          // Multiply by 1.5 if the user has the microwave
          user.game.food += (current * ((user.game.items.includes('Microwave'))? 1.5 : 1));
        }
      }
    }

    await db.set(user.username, newUser);

    socket.emit('message', `You purchased the ${item.name}!`);
    return socket.emit('gameUpdate', {"user": newUser, "notify": false});
  } else if(command == 'mine'){
    // Mining
    if((user.game.location != 'mine') && (user.game.location != 'platinumMine')) return socket.emit('message', 'That is not an available action.');

    const ore = (user.game.location == 'platinumMine')? 'platinum' : 'gold';
    const oreValue = (ore == 'platinum')? 100 : 50;

    // Change stats based on user items, stats, and ore type
    let mineTime = 1000;
    
    const speedReduction = ((user.game.speed + user.game.speedBuff) > 250)? 250 : (user.game.speed + user.game.speedBuff);
    mineTime -= speedReduction;
    
    if(user.game.items.includes('SuperPick')) mineTime -= 350;

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
        
        socket.emit('message', `Finished${punctuation} Found ${oreFound} ${grams} of ${ore}${punctuation} (Earned: $${formatNumber(oreFound * oreValue)})`);

        // Save profit
        let newUser = user;

        newUser.game.money += (oreFound * oreValue);

        // Platinum miner quest
        if((!user.game.completedQuests.includes('platinumminer')) && (ore == 'platinum')){
          newUser.game.completedQuests.push('platinumminer');
          socket.emit('message', '(You feel as though you\'ve completed something important, maybe you should check the quest board!)');
        }
        
        db.set(user.username, newUser);
        socket.emit('gameUpdate', {"user": newUser, "notify": false});

        busyPlayers.delete(user.username);
        clearInterval(mineInterval);
      }
    }, mineTime);
  } else if(command == 'train'){
    // Training
    if(user.game.location != 'gym') return socket.emit('message', 'That is not an available action.');
    const price = (user.game.items.includes('Companion'))? 45 : 50;
    if(user.game.money < price) return socket.emit('message', 'You don\'t have enough money!');

    const maxHealth = ((user.game.level + 1) * 15) + user.game.maxHealth;
    const maxDamage = (user.game.level + 1) * 10;
    const maxSpeed = user.game.level * 5;

    if((user.game.speed >= maxSpeed) && (user.game.damage >= maxDamage) && (user.game.maxHealth >= maxHealth)) return socket.emit('message', 'Your speed, strength, and health stats are already maxed! Level up to increase your maximum stats.');

    let newUser = user;
    newUser.game.money -= price;

    let counter = 0;
    const trainTime = (user.game.items.includes('Supplements'))? 450 : 500;
    
    socket.emit('message', `Training... (${counter * 10}%)`);
    busyPlayers.set(user.username, 'training');
    
    const trainInterval = setInterval(function(){
      counter++;
      socket.emit('message', `Training... (${counter * 10}%)`);
      if(counter >= 10){
        const multiplier = (user.game.items.includes('Supplements'))? 6 : 5; 
        let maxHealthGained = Math.floor(Math.random() * (multiplier - 1)) + Math.ceil((maxHealth - user.game.maxHealth) / 25);
        let damageGained = Math.floor(Math.random() * multiplier) + Math.ceil((maxDamage - user.game.damage) / 25);
        let speedGained = Math.floor(Math.random() * multiplier) + Math.ceil((maxSpeed - user.game.speed) / 25);
        const punctuation = ((damageGained + speedGained) > 0)? '!' : '.';

        // Make sure user isn't over their level stat limit
        if((newUser.game.maxHealth + maxHealthGained) > maxHealth) maxHealthGained = (maxHealth - user.game.maxHealth);
        if((newUser.game.damage + damageGained) > maxDamage) damageGained = (maxDamage - user.game.damage);
        if((newUser.game.speed + speedGained) > maxSpeed) speedGained = (maxSpeed - user.game.speed);
        
        socket.emit('message', `Finished! Speed +${speedGained}, damage +${damageGained}, and max health +${maxHealthGained}!`);

        // Save gainz
        newUser.game.maxHealth += maxHealthGained;
        newUser.game.health += maxHealthGained;
        newUser.game.damage += damageGained;
        newUser.game.speed += speedGained;

        // Double check that health isn't over maximum
        if(newUser.health > (newUser.maxHealth + newUser.maxHealthBuff)) newUser.health = (newUser.maxHealth + newUser.maxHealthBuff);
        
        db.set(user.username, newUser);
        socket.emit('gameUpdate', {"user": newUser, "notify": false});

        busyPlayers.delete(user.username);
        clearInterval(trainInterval);
      }
    }, trainTime);
  } else if(command == 'battle'){
    // Battling
    if((user.game.location != 'camp') && (user.game.location != 'arena')) return socket.emit('message', 'That is not an available action.');

    if(user.game.location == 'camp'){
      // Camp battle
      const enemyHealth = Math.floor((Math.random() + 0.55) * (user.game.damage + user.game.damageBuff));
      const enemy = {
        name: "Opposing Brawler",
        stats: {
          speed: Math.floor((Math.random() + 0.45) * (user.game.speed + user.game.speedBuff)),
          health: enemyHealth,
          maxHealth: enemyHealth,
          damage: Math.floor((Math.random() + 0.4) * user.game.health)
        }
      }
      
      busyPlayers.set(user.username, 'fighting');
      let nextTurn = ((user.game.speed + user.game.speedBuff) >= enemy.stats.speed)? 'user' : 'enemy';
      const startingHP = user.game.health;
      
      const fightInterval = setInterval(function(){
        if(nextTurn == 'user'){
          enemy.stats.health -= (user.game.damage + user.game.damageBuff);
          socket.emit('message', `You attacked the ${enemy.name} and dealt ${user.game.damage + user.game.damageBuff} damage.`);
          nextTurn = 'enemy';
        } else { // else instead of elseif is lost redundancy and potentially bad
          user.game.health -= enemy.stats.damage;
          socket.emit('message', `The ${enemy.name} attacked you and dealt ${enemy.stats.damage} damage.`);
          nextTurn = 'user';
        }
  
        socket.emit('gameUpdate', {"user": user, "notify": false});
        socket.emit('message', `Your health: ${(user.game.health > 0)? user.game.health : 0}/${user.game.maxHealth + user.game.maxHealthBuff}\nEnemy health: ${(enemy.stats.health > 0)? enemy.stats.health : 0}/${enemy.stats.maxHealth}`);
        
        if((user.game.health <= 0) || (enemy.stats.health <= 0)){
          let xpMultiplier;
          
          if(user.game.health > 0){
            // Fight won
            xpMultiplier = 1.1;
            socket.emit('message', `You beat the ${enemy.name}!`);
          } else {
            // Fight lost
            xpMultiplier = 0.1;
            socket.emit('message', `You lost to the ${enemy.name}.`);
          }
  
          const xpGained = Math.ceil(10 * (Math.random() + 0.75) * xpMultiplier);
          let newUser = addXP(user, xpGained, socket);
          newUser.game.health = startingHP;
          
          db.set(user.username, newUser);
          socket.emit('gameUpdate', {"user": newUser, "notify": false});
          busyPlayers.delete(user.username);
          
          clearInterval(fightInterval);
        }
      }, 500);
    } else {
      // Arena battle
      if(!['attack', 'speed', 'defense'].includes(args[0])) return socket.emit('message', 'You need to choose a buff (attack, speed, defense) to battle! Ex. \"battle speed\"');
      if(user.game.money < 100) return socket.emit('message', 'You need to have at least $100 to battle!');
      
      const playerObj = {
        user: user,
        socket: socket,
        buff: args[0]
      }

      busyPlayers.set(user.username, 'waiting for a battle');
      battleQueue.set(user.username, playerObj);

      socket.emit('message', `Matchmaking${(battleQueue.size > 1)? ', should take less than 5 seconds' : ''}...\n(Use the "leave" command to exit the queue)`);
    }
  } else if(command == 'leave'){
    // Leaving the battle queue
    if(!battleQueue.has(user.username)) return socket.emit('message', 'That is not an available action.');

    battleQueue.delete(user.username);
    busyPlayers.delete(user.username);
    
    socket.emit('message', 'Left the matchmaking queue.');
  } else if(command == 'heal'){
    // Healing
    if(user.game.location != 'fountain') return socket.emit('message', 'That is not an available action.');
    if(user.game.money < 5) return socket.emit('message', 'You don\'t have enough money.');

    // Get amount of HP to heal, and cost
    let HPToHeal = ((user.game.maxHealth + user.game.maxHealthBuff) - user.game.health);

    if(HPToHeal <= 0) return socket.emit('message', 'You are already at full health!');

    if(user.game.money < (HPToHeal * 5)) HPToHeal = Math.floor(user.game.money / 5);
    const price = (HPToHeal * 5);
    let newUser = user;
    newUser.game.money -= price;
    newUser.game.health += HPToHeal;
    
    // Save user and update the client
    await db.set(user.username, newUser);
    
    socket.emit('gameUpdate', {"user": newUser, "notify": false});

    // Emit message
    socket.emit('message', `Bizarre Squirrel: [The squirrel looks up at you, and fear wells up in your stomach. You have no idea what to expect, until it jumps up and licks you, covering you in slime. Almost immediately, you pass out.]\n\nYou wake up, and the squirrel is exactly where it was before it attacked you.\nHP Healed: ${HPToHeal} (Current HP: ${newUser.game.health}/${newUser.game.maxHealth + newUser.game.maxHealthBuff})\nMoney spent: $${formatNumber(price)}`);
  } else if(command == 'ally'){
    // Ally system
    if(!gameMap[user.game.location].availableAlliances.includes(args[0])) return socket.emit('message', 'That is not an available action.');
    
    const targetAlly = args[0];

    if(user.game.alliance == targetAlly) return socket.emit('message', 'You are already in this alliance!');
    if(user.game.alliance != '') return socket.emit('message', 'You are already in another alliance!');

    let newUser = user;
    newUser.game.alliance = targetAlly;

    await db.set(user.username, newUser);

    socket.emit('gameUpdate', {"user": newUser, "notify": false});
    socket.emit('message', `Joined the ${targetAlly} alliance!`);
  } else if(command == 'eat'){
    // Eating system
    if(user.game.health >= (user.game.maxHealth + user.game.maxHealthBuff)) return socket.emit('message', 'You are already at full health!');
    
    let healAmount;
    let oldHealth = user.game.health;
    let newUser = user;
    let message;

    if(user.game.items.includes('Pouch')){
      // User has food pouch
      healAmount = Math.floor(+args[0]);
    
      if(isNaN(healAmount)) return socket.emit('message', 'You must include a valid food value! Ex. \"eat 25\"');
      if(healAmount > user.game.food) return socket.emit('message', 'You don\'t have that much food!');
      if(healAmount < 1) return socket.emit('message', 'You must eat a minimum of 1!');
      if(healAmount > ((user.game.maxHealth + user.game.maxHealthBuff) - user.game.health)) return socket.emit('message', 'You don\'t need to eat that much!');

      newUser.food -= healAmount;
      newUser.game.health += healAmount;
      
      message = `Healed ${formatNumber(newUser.game.health - oldHealth)} HP!`;
    } else {
      // User is eating normally
      if(!food[args[0]]) return socket.emit('message', 'That is not an available action.');
      if(!user.game.items.includes(capitalizeFirstLetter(args[0]))) return socket.emit('message', 'That is not an available action.');

      // Multiply by 1.5 if user has the microwave
      healAmount = food[args[0]] * ((user.game.items.includes('Microwave'))? 1.5 : 1);
      const foodIndex = newUser.game.items.indexOf(capitalizeFirstLetter(args[0]));
    
      if(foodIndex == -1) return socket.emit('message', 'That is not an available action.');
      newUser.game.items.splice(foodIndex, 1);
      
      newUser.game.health += healAmount;
      if(newUser.game.health > (newUser.game.maxHealth + newUser.game.maxHealthBuff)) newUser.game.health = newUser.game.maxHealth;
      
      message = `Healed ${formatNumber(newUser.game.health - oldHealth)} HP by eating the ${capitalizeFirstLetter(args[0])}!`
    }
    
    await db.set(user.username, newUser);
    
    socket.emit('gameUpdate', {"user": newUser, "notify": false});
    return socket.emit('message', message);
  } else if(command == 'spawn'){
    // Porter
    if(!user.game.items.includes('Porter')) return socket.emit('message', 'That is not an available action.');

    let newUser = user;
    newUser.game.location = 'spawnpoint';

    await db.set(user.username, newUser);
    
    socket.emit('gameUpdate', {"user": newUser, "notify": true});
  } else if(command == 'raid'){
    // Raiding
    if(!((user.game.location == 'penguinHQ') || (user.game.location == 'pigeonHQ'))) return socket.emit('message', 'That is not an available action.');
    if(user.game.level < 5) return socket.emit('message', 'You must be at least level 5 to participate in a raid!');

    // Check airdrop buff
    const currentAirdrop = await airdrops.get(user.game.alliance);
    if(!currentAirdrop) await validateAirdrops();

    const airdropActive = (((Date.now() - currentAirdrop) / (1000 * 60)) < 45);

    // Set player as busy and save + start the raid
    busyPlayers.set(user.username, 'raiding');
    raidingPlayers.set(user.username,{
      'team': user.game.alliance,
      'location': 'start',
      'score': 0,
      'troops': (50 * ((airdropActive == true)? 1.4 : 1))
    });
    
    return socket.emit('message', raidMap[user.game.alliance].start.text);
  } else if(command == 'option'){
    let raid = raidingPlayers.get(user.username);
    
    if(!raid) return socket.emit('message', 'That is not an available action.');

    const selectedOption = raidMap[raid.team][raid.location].options[(+args[0] - 1)];
    
    if(!selectedOption) return socket.emit('message', 'You must specify what option you want to choose! Ex. \"option 1\"');

    socket.emit('message', selectedOption.text);

    // Update raid
    raid.troops -= selectedOption.troopsLost;
    
    if((raid.troops > 0) && (selectedOption.destination != 'victory')){
      raid.score += selectedOption.score;
      raid.location = selectedOption.destination;

      raidingPlayers.set(user.username, raid);
      socket.emit('message', raidMap[raid.team][raid.location].text);
    } else {
      // Raid complete
      const victory = (selectedOption.destination == 'victory')? true : false;

      // Update raid scores
      const oldScore = await raidScores.get(raid.team);
      raidScores.set(raid.team, (oldScore + 1));
      
      raidingPlayers.delete(user.username);
      busyPlayers.delete(user.username);

      // Check airdrop buff
      const currentAirdrop = await airdrops.get(user.game.alliance);
      if(!currentAirdrop) await validateAirdrops();
  
      const airdropActive = (((Date.now() - currentAirdrop) / (1000 * 60)) < 45);

      // Calculate XP
      const xpMultiplier = (victory == true)? (1.1 + (Math.random() / 3)) : 0.75;
      const troopBonus = Math.floor(raid.troops / 3.3);
      let xpGained = ((raid.score + troopBonus) * xpMultiplier) + ((victory == true)? (user.game.xpRequired / 15) : 0);
      if((xpGained < 35) && (victory == true)) xpGained = 35;
      if(xpGained > 250) xpGained = 250;

      // Apply airdrop buff
      if(airdropActive == true) xpGained = (xpGained * 1.3);
      
      socket.emit('message', `${(victory == true)? 'Raid successful!' : 'All of your troops have died. You manage to make it back to base alive.'}\nFinal score: ${raid.score}${(troopBonus > 0)? `\nRemaining troop bonus: ${troopBonus}` : ''}${(airdropActive == true)? '\n(Airdrop bonus included!)' : ''}`);
      
      let newUser = addXP(user, xpGained, socket);

      // Warring nations quest
      if((victory == true) && (!user.game.completedQuests.includes('warringnations'))) newUser.game.completedQuests.push('warringnations');
      
      await db.set(user.username, newUser);
      socket.emit('gameUpdate', {"user": newUser, "notify": true});
    }
  } else if(command == 'airdrop'){
    // Airdrops
    // Check that user is in a headquarters location and is at least level 5
    if(!((user.game.location == 'penguinHQ') || (user.game.location == 'pigeonHQ'))) return socket.emit('message', 'That is not an available action.');
    if(user.game.level < 5) return socket.emit('message', 'You must be at least level 5 to purchase an airdrop.');

    // Check if player has enough money, accounting for companion
    const price = (user.game.items.includes('Companion'))? 450_000 : 500_000;
    if(user.game.money < price) return socket.emit('message', 'You don\'t have enough money to buy an airdrop.');

    let newUser = user;

    // Team Player quest
    if(!user.game.completedQuests.includes('teamplayer')){
      newUser.game.completedQuests.push('teamplayer');
      socket.emit('message', '(You feel as though you\'ve completed something important, maybe you should check the quest board!)');
    }

    // Subtract cost and save user
    newUser.game.money -= price;
    db.set(user.username, newUser);

    const currentAirdrop = await airdrops.get(user.game.alliance);
    const time = Date.now();
    
    if(!currentAirdrop) await validateAirdrops();

    const minutesSinceAirdrop = ((time - currentAirdrop) / (1000 * 60));
    let newAirdrop;

    // Update airdrop in airdrop DB
    if(minutesSinceAirdrop >= 45){
      newAirdrop = (time + (45 * 60 * 1000));
    } else {
      newAirdrop = (currentAirdrop + (45 * 60 * 1000));
    }

    airdrops.set(user.game.alliance, newAirdrop);

    const remainingMinutes = Math.ceil((newAirdrop - time) / (1000 * 60));

    return socket.emit('message', `You purchased an airdrop and boosted the ${capitalizeFirstLetter(user.game.alliance)} Team's raids for 45 minutes! Current airdrop boost will last for a total of: ${remainingMinutes} minute${(remainingMinutes == 1)? '' : 's'}.`);
  } else if(command == 'activeairdrops'){
    // Active airdrop checker
    // Check that user is in a headquarters location
    if(!((user.game.location == 'penguinHQ') || (user.game.location == 'pigeonHQ'))) return socket.emit('message', 'That is not an available action.');

    const currentAirdrop = await airdrops.get(user.game.alliance);

    if(!currentAirdrop) await validateAirdrops();
    
    const time = Date.now();
    const remainingMinutes = Math.ceil((currentAirdrop - time) / (1000 * 60));
    const minutesSinceAirdrop = ((time - currentAirdrop) / (1000 * 60));
    
    const message = (minutesSinceAirdrop < 45)? `Current ${capitalizeFirstLetter(user.game.alliance)} airdrop boost will last for a total of: ${remainingMinutes} minute${(remainingMinutes == 1)? '' : 's'}.` : `No ${capitalizeFirstLetter(user.game.alliance)} airdrops are currently active.`;
    
    return socket.emit('message', message);
  } else if(command == 'blackjack'){
    if(user.game.location != 'diner') return socket.emit('message', 'That is not an available action.');
      
    const oldGame = blackjackGames.get(user.username);
    if(oldGame != undefined) return socket.emit('message', 'You are already in a game of blackjack!');

    const bet = Math.floor(+args[0]);
    
    if(isNaN(bet)) return socket.emit('message', 'You must include a valid bet value! Ex. \"blackjack 100\"');
    if(bet > user.game.money) return socket.emit('message', 'You don\'t have that much money!');
    if(bet < 1) return socket.emit('message', 'You must bet a minimum of $1!');

    const game = new Blackjack(bet, user, socket);
    
    blackjackGames.set(user.username, game);
  } else if(command == 'hit'){
    if(user.game.location != 'diner') return socket.emit('message', 'That is not an available action.');
    
    const game = blackjackGames.get(user.username);
    if(!game) return socket.emit('message', 'You must already be in a game of blackjack to play!');
    
    game.hit();
  } else if(command == 'double'){
    if(user.game.location != 'diner') return socket.emit('message', 'That is not an available action.');
    
    const game = blackjackGames.get(user.username);
    if(!game) return socket.emit('message', 'You must already be in a game of blackjack to play!');
    
    game.double();
  } else if(command == 'stand'){
    if(user.game.location != 'diner') return socket.emit('message', 'That is not an available action.');
    
    const game = blackjackGames.get(user.username);
    if(!game) return socket.emit('message', 'You must already be in a game of blackjack to play!');
    
    game.end();
  } else if(command == 'quests'){
    // Quest system
    if(user.game.location != 'courtyard') return socket.emit('message', 'That is not an available action.');

    let incompleteQuests = '';
    let completedQuests = '';
    let newlyCompletedQuests = '';
    let totalReward = 0;

    let newUser = user;

    for(let key of Object.keys(quests)){
      const quest = quests[key];
      
      if(user.game.highestLevel >= quest.appearAtLevel){
        if(user.game.completedQuests.includes(key)){
          completedQuests += `${quest.name}${(quest.secret == true)? ' (Secret)' : ''} - ${quest.description} - Reward: $${formatNumber(quest.reward)}\n`;
          
          if(!user.game.claimedQuests.includes(key)){
            newlyCompletedQuests += `${quest.name}, `;
            totalReward += quest.reward;
  
            newUser.game.claimedQuests.push(key);
            newUser.game.money += quest.reward;
          }
        } else {
          if(quest.secret == false){
            incompleteQuests += `${quest.name} - ${quest.description} - Reward: $${formatNumber(quest.reward)}\n`;
          } else {
            incompleteQuests += '???\n';
          }
        }
      }
    }

    let message = '';

    if(incompleteQuests != '') message += `INCOMPLETE Quests:\n\n${incompleteQuests}\n`;
    if(completedQuests != '') message += `COMPLETED Quests:\n\n${completedQuests}\n`;
    if(newlyCompletedQuests != '') message += `Newly completed quests!\n\n${newlyCompletedQuests.slice(0, -2)}\nTotal rewards: $${formatNumber(totalReward)}\n`;

    message += '\nIf you complete a quest, come back and use the \"quests\" command to claim your rewards!';

    socket.emit('message', message);

    await db.set(user.username, newUser);
    socket.emit('gameUpdate', {"user": newUser, "notify": false});
  } else if (command == 'raidreward'){
    // Raid stats and reward
    if(user.game.location != 'courtyard') return socket.emit('message', 'That is not an available action.');

    const penguinScore = await raidScores.get('penguin');
    const pigeonScore = await raidScores.get('pigeon');
    const totalScore = penguinScore + pigeonScore;

    if((!penguinScore) || (!pigeonScore)) await validateRaidScores();
    
    const penguinMultiplier = (totalScore > 0)? (penguinScore / (penguinScore + pigeonScore)) : 0.5;
    const pigeonMultiplier = (totalScore > 0)? (pigeonScore / (penguinScore + pigeonScore)) : 0.5;
    
    const multipliers = {
      'penguin': (penguinMultiplier >= 0.5)? (penguinMultiplier + 0.5) : penguinMultiplier,
      'pigeon': (pigeonMultiplier >= 0.5)? (pigeonMultiplier + 0.5) : pigeonMultiplier
    }

    let message = `Currently, the Penguins have won ~${Math.floor(penguinMultiplier * 100)}% of raids (${penguinScore}), and the Pigeons have won ~${Math.floor(pigeonMultiplier * 100)}% of raids. (${pigeonScore})`;

    if(user.game.alliance == ''){
      message += '\n(If you join an alliance, you can come back here to collect a daily reward depending on the victory rate of your alliance!)';
      return socket.emit('message', message);
    }
    
    const time = Date.now();
    
    if((time - user.game.lastDailyReward) > (1000 * 60 * 60 * 24)){
      const finalReward = Math.floor(200 * (1 + (user.game.level / 5)) * multipliers[user.game.alliance]);
  
      let newUser = user;
      newUser.game.money += finalReward;
      newUser.game.lastDailyReward = time;

      message += `\nSince you are on the ${capitalizeFirstLetter(user.game.alliance)} alliance, and at a level of ${user.game.level}, your daily reward comes to $${formatNumber(finalReward)}!\nReward collected.`;
      
      socket.emit('message', message);
    
      await db.set(user.username, newUser);
      socket.emit('gameUpdate', {"user": newUser, "notify": false});
    } else {
      const hours = (24 - Math.floor((time - user.game.lastDailyReward) / (1000 * 60 * 60)));
      message += `\n(You can only collect your daily reward once every 24 hours, yours will be next available in ~${hours} hour${(hours == 1)? '' : 's'}.)`;

      socket.emit('message', message);
    }
  } else if(command == 'prestige'){
    // Prestiging
    if(user.game.level < (50 + (user.game.prestige * 10))) return socket.emit('message', `You can only prestige when you've reached the your level cap! Currently, you are level ${user.game.level}/${(50 + (user.game.prestige * 10))}!`);
      
    if(prestigeRequests.has(user.username)){
      prestigeRequests.delete(user.username);
      let newUser = user;
      
      newUser.game.level = 1;
      newUser.game.xpRequired = xpRequired(newUser.game.level);
      newUser.game.speed = 1;
      newUser.game.damage = 15;
      newUser.game.maxHealth = 100;
      if(newUser.game.health > (newUser.game.maxHealth + newUser.game.maxHealthBuff)) newUser.game.health = (newUser.game.maxHealth + newUser.game.maxHealthBuff);
      newUser.game.prestige++;

      // Prestigious Player quests
      if(!newUser.game.completedQuests.includes('prestigiousplayer')){
        newUser.game.completedQuests.push('prestigiousplayer');
      } else if((!newUser.game.completedQuests.includes('prestigiousplayertwo')) && (newUser.game.prestige >= 5)){
        newUser.game.completedQuests.push('prestigiousplayertwo');
      } else if((!newUser.game.completedQuests.includes('prestigiousplayerthree')) && (newUser.game.prestige >= 10)){
        newUser.game.completedQuests.push('prestigiousplayerthree');
      }

      db.set(user.username, newUser);

      return socket.emit('message', `You prestiged! Prestige level: ${newUser.game.prestige}`);
    } else {
      prestigeRequests.set(user.username, '');
      socket.emit('message', 'Are you sure? Prestiging will reset your level and stats! Type \"prestige\" once more within 60 seconds to confirm!');
      setTimeout(function(){
        if(prestigeRequests.has(user.username)) prestigeRequests.delete(user.username);
      }, 60000);
    }
  } else if(command == 'playerinfo'){
    // Player info
    if(!args[0]) return socket.emit('message', 'You must provide a player\'s username to search! Ex. \"playerinfo {username}\"');

    const player = await db.get(args[0]);
    if(!player) return socket.emit('message', `Player "${args[0]}" not found. (Usernames are case-sensitive!)`);

    // Make sure the player has a "game" object, otherwise users could request things like "playerinfo username.game.money" and crash the server
    const playerInfo = player.game;
    if(!playerInfo) return socket.emit('message', `Player "${args[0]}" not found. (Usernames are case-sensitive!)`);
    
    return socket.emit('message', `${args[0]} (${(connectedPlayers.has(args[0]))? 'Online' : 'Offline'}):\n\nAlliance: ${(playerInfo.alliance == '')? 'None' : capitalizeFirstLetter(playerInfo.alliance)}\nLevel: ${playerInfo.level}\nPrestige: ${playerInfo.prestige}\nBalance: $${playerInfo.money}\nLocation: ${(user.game.discoveredLocations.includes(playerInfo.location))? gameMap[playerInfo.location].name : '???'}`);
  } else if(command == 'playersonline'){
    // Players online
    socket.emit('message', `Players online: ${[...connectedPlayers.keys()].join(', ')}`);
  } else if(command == 'burn'){
    // Burners quest
    if(user.game.location != 'field') return socket.emit('message', 'That is not an available action.');
    if(user.game.completedQuests.includes('burners')) return socket.emit('message', 'The cabin is already burned to the ground!');

    socket.emit('message', 'Upon closer inspection, the canister has a small trademark inscribed near the nozzle that reads \"Burners\". You pick it up and begin pouring the gas onto the cabin, and even though you pour out what should have been all of the gas, the canister is still full when you finish. You strike a match and light the building on fire.\n(You feel as though you\'ve completed something important, maybe you should check the quest board!)');

    let newUser = user;
    newUser.game.completedQuests.push('burners');
    await db.set(user.username, newUser);

    socket.emit('gameUpdate', {"user": newUser, "notify": false});
  } else if(command == 'reset'){
    if(resetRequests.has(user.username)){
      resetRequests.delete(user.username);
      
      db.delete(user.username);
      
      socket.emit('reload');
      socket.disconnect();
    } else {
      resetRequests.set(user.username, '');
      socket.emit('message', 'If you are sure you want to PERMANENTLY DELETE your progress, type \"reset\" one more time within the next 10 seconds.');
      setTimeout(function(){
        if(resetRequests.has(user.username)) resetRequests.delete(user.username);
      }, 10000);
    }
  } else {
    // Unrecognized command
    return socket.emit('message', 'That is not an available action.');
  }
}


// XP and leveling

function addXP(user, xpGained, socket){
  user.game.xp += Math.floor(xpGained);
  socket.emit('message', `Gained ${Math.floor(xpGained)}XP!`);
  
  while(user.game.xp >= user.game.xpRequired){
    if(user.game.level < (50 + (user.game.prestige * 10))){
      user.game.level++;
      if(user.game.highestLevel < user.game.level) user.game.highestLevel = user.game.level;
      user.game.xp = user.game.xp - user.game.xpRequired;
      user.game.xpRequired = xpRequired(user.game.level);
      socket.emit('message', `Leveled up! Now level ${user.game.level}.`);
    }
  }

  // Junior player quest
  if((user.game.level >= 10) && (!user.game.completedQuests.includes('juniorplayer'))) user.game.completedQuests.push('juniorplayer');

  // Senior player quest
  if((user.game.level >= 100) && (!user.game.completedQuests.includes('seniorplayer'))) user.game.completedQuests.push('seniorplayer');

  if(user.game.level >= (50 + (user.game.prestige * 10))){
    socket.emit('message', `You're currently at the highest level (${user.game.level}) for your prestige ${user.game.prestige}! To unlock a higher prestige, use the "prestige" command which will reset your level but increase your level cap by 10.`);
  } else {
    socket.emit('message', `${user.game.xpRequired - user.game.xp}XP until next level.`);
  }
  
  return user;
}


function xpRequired(currentLevel){
  const uncapped = Math.ceil((currentLevel + Math.sqrt(currentLevel)) / 5) * 5 * (Math.ceil(currentLevel / 10) * 10);
  return (uncapped > 5000)? 5000 : uncapped;
}


// Raid Score and Airdrop DB's

async function validateRaidScores(){
  const penguinScore = await raidScores.get('penguin');
  const pigeonScore = await raidScores.get('pigeon');
  
  if(!penguinScore) raidScores.set('penguin', 0);
  if(!pigeonScore) raidScores.set('pigeon', 0);
}

async function validateAirdrops(){
  const penguinAirdrop = await airdrops.get('penguin');
  const pigeonAirdrop = await airdrops.get('pigeon');
  
  if(!penguinAirdrop) airdrops.set('penguin', 0);
  if(!pigeonAirdrop) airdrops.set('pigeon', 0);
}

// Validate DB's on startup
validateRaidScores();
validateAirdrops();


// Blackjack

class Deck{
  constructor(){
    this.cards = ['as', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', 'js', 'qs', 'ks', 'ah', '2h', '3h', '4h', '5h', '6h', '7h', '8h', '9h', '10h', 'jh', 'qh', 'kh', 'ac', '2c', '3c', '4c', '5c', '6c', '7c', '8c', '9c', '10c', 'jc', 'qc', 'kc', 'ad', '2d', '3d', '4d', '5d', '6d', '7d', '8d', '9d', '10d', 'jd', 'qd', 'kd'];
  }

  shuffle(){
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = this.cards[i];
      this.cards[i] = this.cards[j];
      this.cards[j] = temp;
    }
  }

  draw(amount){
    let cards = [];
    
    for (let i = 0; i < amount; i++) {
      cards.push(this.cards[0]);
      this.cards.shift();
    }

    return cards;
  }
}

class Blackjack{
  constructor(bet, user, socket){
    this.bet = bet;
    this.user = user;
    this.socket = socket;
    
    this.deck = new Deck();
    this.deck.shuffle();

    // I know that this isn't how you would deal in real life, but it doesn't matter since that's only a rule to prevent cheating, which can't be done here anyways.
    this.dealerHand = this.deck.draw(2);
    this.playerHand = this.deck.draw(2);

    if(this.total(this.playerHand) == 21){
      this.end();
    } else {
      this.updateUser();
    }
  }

  // Find total score of a hand
  total(hand){
    let total = 0;
    let hasAce = false;

    for(let card of hand){
      const value = card.slice(0, -1);
      const faces = ['j', 'q', 'k'];
      
      if(faces.includes(value)){
        // Card is a face card
        total += 10;
      } else if(value == 'a'){
        // Card is an ace
        total += 11;
        hasAce = true;
      } else {
        // Card is a number
        total += +value
      }
    }

    if((total > 21) && (hasAce == true)){
      total -= 10;
    }

    return total;
  }

  // Change card from basic string to pretty uppercase one using suit characters
  formatCard(card){
    let newCard = card;
    
    if(newCard.slice(-1) == 's') newCard = newCard.slice(0, -1) + '♤';
    if(newCard.slice(-1) == 'h') newCard = newCard.slice(0, -1) + '♡';
    if(newCard.slice(-1) == 'c') newCard = newCard.slice(0, -1) + '♧';
    if(newCard.slice(-1) == 'd') newCard = newCard.slice(0, -1) + '♢';

    return newCard.toUpperCase();
  }

  // Generate a string to emit to the user
  updateUser(playerStood = false){
    const playerTotal = this.total(this.playerHand);
    let playerHandString = '';
    let dealerHandString = '';

    for(let card of this.playerHand){
      playerHandString += `${this.formatCard(card)} `;
    }

    if(playerStood == true){
      for(let card of this.dealerHand){
        dealerHandString += `${this.formatCard(card)} `;
      }
    }
    
    const gameString = `\n\nDealer's hand\n ${(playerStood == true)? dealerHandString : `${this.formatCard(this.dealerHand[1])} ??`}${(playerStood == true)? `(${this.total(this.dealerHand)})` : ''}\n\n ${playerHandString}(${playerTotal})\nYour hand\n`;

    return this.socket.emit('message', gameString);
  }

  // Hit the player's hand
  hit(){
    this.playerHand.push(...this.deck.draw(1));
    if(this.total(this.playerHand) > 21){
      this.end();
    } else {
      this.updateUser();
    }
  }

  // Double: double bet and hit once before ending the game
  double(){
    if(this.playerHand.length != 2) return this.socket.emit('message', 'You can only double before hitting!');
    if(this.user.game.money < (this.bet * 2)) return this.socket.emit('message', 'You don\'t have enough money to double your bet!');
    
    this.bet = this.bet * 2;
    this.hit();

    // Make sure the end() function is only called once
    if(this.total(this.playerHand) > 21) return;
    this.end();
  }

  // End the game and determine payout/loss
  async end(){
    const playerTotal = this.total(this.playerHand);
    let status = '';
    let payout = 0;
    
    if((playerTotal == 21) && (this.playerHand.length == 2)){
      // Blackjack
      payout = Math.floor(this.bet * 1.5);
      status = 'Blackjack!';
    } else if(playerTotal > 21){
      // Bust
      payout = -this.bet;
      status = 'Bust.'
    } else {
      while(this.total(this.dealerHand) < 17){
        this.dealerHand.push(...this.deck.draw(1));
      }

      const dealerTotal = this.total(this.dealerHand);

      if(dealerTotal > 21){
        // Dealer bust
        payout = this.bet;
        status = 'Dealer bust!';
      } else if(playerTotal > dealerTotal){
        // Player beat dealer
        payout = this.bet;
        status = 'Player higher score!';
      } else if(playerTotal < dealerTotal){
        // Dealer beat player
        payout = -this.bet;
        status = 'Dealer higher score.';
      } else {
        // Push
        payout = 0;
        status = 'Push.';
      }
    }

    let newUser = this.user;
    newUser.game.money += payout;
    
    await db.set(this.user.username, newUser);
    this.socket.emit('gameUpdate', {"user": newUser, "notify": false});
    
    this.updateUser(true);

    setTimeout(function(){
      this.socket.emit('message', status);
    }.bind(this), 1000);
    // .bind(this) binds the timeout function to the original .this object, very useful

    busyPlayers.delete(this.user.username);
    blackjackGames.delete(this.user.username);

    return setTimeout(function(){
      this.socket.emit('message', `${(payout >= 0)? 'Gained': 'Lost'} $${formatNumber(Math.abs(payout))}${(payout > 0)? '!' : '.'}`);
    }.bind(this), 2000);
  }
}


// Online battles

function onlineBattle(playerOne, playerTwo){
  // Shuffle the players
  if(Math.random() < 0.5){
    let temp = playerOne;
    playerOne = playerTwo;
    playerTwo = temp;
  }

  playerOne.startingStats = [playerOne.user.game.speed, playerOne.user.game.damage, playerOne.user.game.health];
  playerTwo.startingStats = [playerTwo.user.game.speed, playerTwo.user.game.damage, playerTwo.user.game.health];

  // Set as busy, apply buffs and elixirs
  for(let i in [playerOne, playerTwo]){
    const player = [playerOne, playerTwo][i];
    const otherPlayer = [playerOne, playerTwo][((i == 0)? 1 : 0)];
    
    busyPlayers.set(player.user.username, 'fighting');

    player.buff = {
      attack: (player.buff == 'attack')? (Math.ceil(player.user.game.damage / 6)) : 0,
      speed: (player.buff == 'speed')? (Math.ceil(player.user.game.level / 5) * 10) : 0,
      defense: (player.buff == 'defense')? (Math.ceil(player.user.game.damage / 6)) : 0
    }

    const time = Date.now();

    // Only apply elixir buffs if the player has bought an elixir in the last 45 minutes and the other player has achieved level 100
    if(((time - player.user.game.lastElixir) <= (1000 * 60 * 45)) && (otherPlayer.user.game.highestLevel >= 100)){
      player.user.game.damage += Math.ceil(player.user.game.damage / 2);
      player.user.game.health += player.user.game.health;
    }
  }
  
  let nextTurn = ((playerOne.user.game.speed + playerTwo.user.game.speedBuff + playerOne.buff.speed) >= (playerTwo.user.game.speed + playerOne.user.game.speedBuff + playerOne.buff.speed))? 'playerOne' : 'playerTwo';

  const fightInterval = setInterval(function(){
    const attackingPlayer = (nextTurn == 'playerOne')? playerOne : playerTwo;
    const defendingPlayer = (nextTurn == 'playerTwo')? playerOne : playerTwo;

    // Deal damage to the defending player
    const dealtDamage = attackingPlayer.user.game.damage + attackingPlayer.user.game.damageBuff + attackingPlayer.buff.attack - defendingPlayer.buff.defense;

    defendingPlayer.user.game.health -= dealtDamage;

    // Update players and set next turn
    if(nextTurn == 'playerOne'){
      playerOne = attackingPlayer;
      playerTwo = defendingPlayer;
      
      nextTurn = 'playerTwo';
    } else {
      playerOne = defendingPlayer;
      playerTwo = attackingPlayer;
      
      nextTurn = 'playerOne';
    }

    // Emit update message
    const message = `${attackingPlayer.user.username} attacked ${defendingPlayer.user.username} and dealt ${dealtDamage} damage!\nDealt: ${attackingPlayer.user.game.damage + attackingPlayer.user.game.damageBuff + attackingPlayer.buff.attack}\nBlocked: ${defendingPlayer.buff.defense}\n\n${playerOne.user.username}'s health: ${(playerOne.user.game.health > 0)? playerOne.user.game.health : 0}HP\n${playerTwo.user.username}'s health: ${(playerTwo.user.game.health > 0)? playerTwo.user.game.health : 0}HP`;

    playerOne.socket.emit('message', message);
    playerTwo.socket.emit('message', message);

    if((playerOne.user.game.health <= 0) || (playerTwo.user.game.health <= 0)){
      let winMessage;
      let winner;

      // Pay out and formulate the winning message
      if(playerOne.user.game.health <= 0){
        // Player two wins
        winner = playerTwo;
        loser = playerOne;

        // Account for companion
        const multiplier = (playerOne.user.game.items.includes('Companion'))? 0.09 : 0.1;
        
        winMessage = `${playerTwo.user.username} beat ${playerOne.user.username} and won $${formatNumber(Math.floor(playerOne.user.game.money * multiplier))}!`;
        
        playerTwo.user.game.money += Math.floor(playerOne.user.game.money * multiplier);
        playerOne.user.game.money -= Math.floor(playerOne.user.game.money * multiplier);
      } else {
        // Player one wins
        winner = playerOne;
        loser = playerTwo;

        // Account for companion
        const multiplier = (playerTwo.user.game.items.includes('Companion'))? 0.09 : 0.1;
        
        winMessage = `${playerOne.user.username} beat ${playerTwo.user.username} and won $${Math.floor(playerTwo.user.game.money * multiplier)}!`;
        
        playerOne.user.game.money += Math.floor(playerTwo.user.game.money * multiplier);
        playerTwo.user.game.money -= Math.floor(playerTwo.user.game.money * multiplier);
      }

      // Reset player stats, save, give XP, and clean up
      for(let player of [playerOne, playerTwo]){

        // Nice one-liner to set multiple values at once
        [player.user.game.speed, player.user.game.damage, player.user.game.health] = [...player.startingStats];
        
        let xpGained;
        if(player.user.username == winner.username){
          const levelDifference = (loser.user.game.level >= winner.user.game.level)? (loser.user.game.level - winner.user.game.level) : 0;
          xpGained = 10 + (levelDifference ** 1.75);

          // Ringfighter quest
          if(!player.user.game.completedQuests.includes('ringfighter')) player.user.game.completedQuests.push('ringfighter');
        } else {
          xpGained = Math.ceil(10 * Math.random());
        }
        
        player.socket.emit('message', winMessage);

        player.user = addXP(player.user, xpGained, player.socket);
        db.set(player.user.username, player.user);
        
        player.socket.emit('gameUpdate', {"user": player.user, "notify": true});
        
        busyPlayers.delete(player.user.username);
      }
      
      clearInterval(fightInterval);
    }
  }, 1500);
}

function matchmakeBattles(){
  // Return if less than 2 players are waiting
  if(battleQueue.size < 2) return;
    
  const battleArray = [...battleQueue.values()];

  // Sort players by money
  battleArray.sort((a, b) => b.user.game.money - a.user.game.money);
  
  let pairs = [];

  // Make pairs
  battleArray.reduce(function(result, value, index, array) {
    if (index % 2 === 0) pairs.push(array.slice(index, index + 2));
  }, []);

  // Battle each pair
  for(let pair of pairs){
    const elixirsActiveMessage = ((pair[0].user.game.highestLevel >= 100) && (pair[1].user.game.highestLevel >= 100))? '\nActive elixirs WILL be applied in this battle!' : '';
    
    for(let player in pair){
      battleQueue.delete(pair[player].user.username);
      pair[player].socket.emit('message', `Found match! Opponent: ${(player == 0)? pair[1].user.username : pair[0].user.username}${elixirsActiveMessage}`);
    }

    // Allow players a second to read the message before starting the battle
    setTimeout(function(){
      onlineBattle(pair[0], pair[1]);
    }, 1000)
  }
}

// Make matches every 5 seconds
setInterval(matchmakeBattles, 5000);


// Chat

async function sendChat(username, msg, socket){
  if((msg.charAt(0) == '/') && (username === 'CatR3kd')) return chatCommand(msg, socket.id);
  if((msg.length < 1) || (msg.length > 199)) return;

  const user = await db.get(username);

  if(user.banStatus == true) return systemMessage(socket.id, 'You are currently banned from sending chat messages.');

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
    badgeColor: badgeColor,
    prestige: socket.rooms.has('Prestige Hall'),
    system: false
  }

  // Emit to correct room
  if(socket.rooms.has('Prestige Hall')){
    io.to("Prestige Hall").emit('chatMsg', msgObj);
  } else {
    io.emit('chatMsg', msgObj);
  }
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
    if(!targetSocket) return systemMessage(socketID, 'User not found.');

    io.to(targetSocket).emit('reload');
    return systemMessage(socketID, `Kicked user ${args[0]}.`);
  }

  if(command == 'warn'){
    const targetSocket = await connectedPlayers.get(args[0]);
    if(!targetSocket) return systemMessage(socketID, 'User not found.');
    if(!args[1]) return systemMessage(socketID, 'You need to provide a warning message.');

    systemMessage(targetSocket, `An admin has warned you: ${args[1]}`);
    return systemMessage(socketID, `Warned user ${args[0]}: ${args[1]}`);
  }

  // Ban
  if(command == 'ban'){
    if(args[0] == 'CatR3kd') return systemMessage(socketID, 'Cannot ban this user!');
    
    const targetUser = await db.get(args[0]);
    if(!targetUser) return systemMessage(socketID, 'User not found.');

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
    if(!targetUser) return systemMessage(socketID, 'User not found.');

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
    badgeColor: '#F45B69',
    prestige: false,
    system: true
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
      prestige: user.value.game.prestige,
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

function formatNumber(number){
  return(number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','));
}


// Replit tip system

let tippers = [];
let topTipper = '';

async function updateTips(){
  await fetch('https://catr3kd-tip-api.catr3kd.repl.co/all?replId=64cefdf4-f0a7-4643-a002-1423cf53324a', {method: 'GET'})
  .then(r => r.json().then(res => {
  	tippers = (res.users || []);
  })).catch((error) => {
    //console.error(error);
  });
  await fetch('https://catr3kd-tip-api.catr3kd.repl.co/top?replId=64cefdf4-f0a7-4643-a002-1423cf53324a', {method: 'GET'})
  .then(r => r.json().then(res => {
  	topTipper = (res.topTipper || '');
  })).catch((error) => {
    //console.error(error);
  });
}

updateTips();
setInterval(updateTips, 10_000);