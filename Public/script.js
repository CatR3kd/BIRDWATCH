(() => {	
  socket = io();
  let map;
  let savedUser;

  fetch('https://ta.catr3kd.repl.co/map')
  .then((response) => response.json())
  .then((data) => {
  	map = data;
  });
  
  socket.on('loggedIn', function(user){
    document.getElementById('login').style.visibility = 'hidden';
    document.getElementById('content').style.visibility = 'visible';
    updateGame({"user": user, "notify": true});
  });

  socket.on('gameUpdate', function(updateObj){
    updateGame(updateObj);
  });

  socket.on('message', function(message){
    const text = document.getElementById('text');
    text.innerText = `${text.innerText}${message}\n\n`;
    scroll();
  });
  
  document.getElementById('actionInput').addEventListener('keyup', function(event) {
    if(event.keyCode === 13){
      event.preventDefault();
      sendAction();
    }
  });
  
  function sendAction(){
    const input = document.getElementById('actionInput');
    const action = input.value;
    let args = action.split(' ');
    const command = args[0];
    args.shift();
    input.value = '';
  
    const actionObj = {
      command: command,
      args: args
    };

    if(command.toLowerCase() == 'help') return help();
    if(command.toLowerCase() == 'location') return location();
    if(command.toLowerCase() == 'balance') return balance();
    if(command.toLowerCase() == 'inventory') return inventory();
    if(command.toLowerCase() == 'stats') return stats();
    
    socket.emit('action', actionObj);
  }

  function help(){
    const text = document.getElementById('text');
    
    text.innerText = text.innerText + `Use commands to navigate and interact with the game!
    Global commands:
    "location" Reminds you of your surroundings.
    "stats": List your current stats. (Health, strength, speed, etc.)
    "balance" Tells you how much money you have.
    "inventory" Shows you what items you own.
    "move {direction}" Moves you in a given direction. (North, South, East, West)
    NOTE: There are other location-specific commands that will be explained by other characters.\n\n`;
    
    scroll();
  }

  function location(){
    const text = document.getElementById('text');
      const location = map[savedUser.game.location];

      let addedMessage = '\n';

      Object.keys(location.neighbors).forEach(function(key){
        const neighbor = map[location.neighbors[key]];
        addedMessage +=`\n${key.charAt(0).toUpperCase() + key.slice(1)}: ${neighbor.name}`;
      });
    
      for(let enemyID in location.enemies){
        const enemy = location.enemies[enemyID];
        
        if(!(savedUser.game.defeatedEnemies.includes(enemy.name))) addedMessage += `\n${enemyID.charAt(0).toUpperCase() + enemyID.slice(1)} blocks travel to the ${enemy.blockedDirection}! ("fight ${enemyID}")`;
      }
      
      text.innerText = `${text.innerText}Entered ${map[savedUser.game.location].name}.\n${map[savedUser.game.location].text}${addedMessage}\n\n`;
      
      scroll();
  }

  function balance(){
    const text = document.getElementById('text');
    
    text.innerText = `${text.innerText}Current balance: $${savedUser.game.money}\n\n`;
    
    scroll();
  }

  function stats(){
    const text = document.getElementById('text');
    
    text.innerText = `${text.innerText}Health: ${savedUser.game.health}/${savedUser.game.maxHealth}\nStrength: ${savedUser.game.damage}\nSpeed: ${savedUser.game.speed}\n\n`;
    
    scroll();
  }

  function inventory(){
    const inventory = savedUser.game.items;
    let textToDisplay = '';

    if(inventory.length <= 0){
      textToDisplay = 'Your inventory is empty!';
    } else {
      textToDisplay = 'Your items:';
      for(let item of inventory){
        textToDisplay += `\n${item}`;
      }
    }
    
    const text = document.getElementById('text');
    
    text.innerText = `${text.innerText}${textToDisplay}\n\n`;
    
    scroll();
  }

  function updateGame(updateObj){
    savedUser = updateObj.user;
    
    if(updateObj.notify == true){
      location();
    }
  }

  function scroll(){
    const terminal = document.getElementById('terminal');
    terminal.scrollTop = terminal.scrollHeight;
  }
})()