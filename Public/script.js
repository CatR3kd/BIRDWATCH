(() => {	
  socket = io();
  let map;

  fetch('https://ta.catr3kd.repl.co/map')
  .then((response) => response.json())
  .then((data) => {
  	map = data;
  });
  
  socket.on('loggedIn', function(user){
    document.getElementById('login').style.visibility = 'hidden';
    document.getElementById('content').style.visibility = 'visible';
    updateGame(user);
  });

  socket.on('gameUpdate', function(user){
    updateGame(user);
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
    
    socket.emit('action', actionObj);
  }

  function help(){
    const text = document.getElementById('text');
    text.innerText = text.innerText + `Use commands to navigate and interact with the game! Available commands:
    move {direction}\n\n`;
    scroll();
  }

  function updateGame(user){
    const text = document.getElementById('text');
    text.innerText = `${text.innerText}${map[user.game.location].text}\n\n`;
    scroll();
  }

  function scroll(){
    const terminal = document.getElementById('terminal');
    terminal.scrollTop = terminal.scrollHeight;
  }
})()