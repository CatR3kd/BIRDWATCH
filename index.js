const express = require('express');
const app = require('express')();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');
const { QuickDB } = require("quick.db");
const db = new QuickDB({filePath: "Data/db.sqlite"});
const connectedPlayers = new Map();
const busyPlayers = new Map();

const gameMap = getMap();

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

      connectedPlayers.set(username, user);
  
      socket.emit('loggedIn', user);
    }
  })();

  socket.on('action', function(actionObj) {
    const username = socket.handshake.headers['x-replit-user-name'];

    playAction(username, socket, actionObj);
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
    game: new Game()
  }

  await db.set(username, userObj);
  return userObj;
}


// Map

function getMap(){
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

  return JSON.parse(fs.readFileSync('Map/map.json'));
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

  if(command == 'move'){
    // Moving system
    const destinationName = gameMap[user.game.location].neighbors[args[0]];
    const destination = gameMap[destinationName];
    if(destination == undefined) return socket.emit('message', 'That is not an available action.');

    let cannotPass = false;
    
    for(let item of destination.neededToEnter){
      if(!(user.game.items.includes(item))){
        cannotPass = true;
        return socket.emit('message', `You need the "${item}" to pass!`);
      }
    }

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
    const targetNPC= availableNPCs[args[0]];

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
      socket.emit('message', `Your health: ${user.game.health}/${user.game.maxHealth}\nEnemy health:${targetEnemy.stats.health}/${targetEnemy.stats.maxHealth}`);
      
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
      return socket.emit('message', `${item.name}: ${item.description}\nPrice: ${item.price}`);
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

    await db.set(username, newUser);

    socket.emit('message', `You purchased the ${item.name}!`);
    return socket.emit('gameUpdate', {"user": newUser, "notify": false});
  } else if(command == 'mine'){
    // Mining
    if(user.game.location != 'mine') return socket.emit('message', 'That is not an available action.');

    let mineTime = 1000;
    if(user.game.items.includes('SuperPick')) mineTime = 650;

    let counter = 0;

    socket.emit('message', `Mining... (${counter * 10}%)`);
    busyPlayers.set(user.username, 'mining');
    
    const mineInterval = setInterval(function(){
      counter++;
      socket.emit('message', `Mining... (${counter * 10}%)`);

      // Notify and profit when completed
      if(counter >= 10){
        const goldFound = Math.floor(Math.random() * Math.random() * 10);
        const punctuation = (goldFound > 0)? '!' : '.';
        const grams = (goldFound != 1)? 'grams' : 'gram';
        
        socket.emit('message', `Finished${punctuation} Found ${goldFound} ${grams} of gold${punctuation} (Earned: $${goldFound * 50})`);

        // Save profit
        let newUser = user;
        newUser.game.money += (goldFound * 50);
        
        db.set(username, newUser);
        socket.emit('gameUpdate', {"user": newUser, "notify": false});

        busyPlayers.delete(user.username);
        clearInterval(mineInterval);
      }
    }, mineTime);
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
    socket.emit('gameUpdate', {"user": newUser, "notify": false});
    await db.set(username, newUser);

    // Emit message
    socket.emit('message', `Bizarre Squirrel: [The squirrel looks up at you, and fear wells up in your stomach. You have no idea what to expect, until it jumps up and licks you, covering you in slime. Almost immediately, you pass out.]\n\nYou wake up, and the squirrel is exactly where it was before it attacked you.\nHP Healed: ${HPToHeal} (Current HP: ${newUser.game.health}/${newUser.game.maxHealth})\nMoney spent: $${price}`);
  } else {
    // Unrecognized command
    return socket.emit('message', 'That is not an available action.');
  }
}